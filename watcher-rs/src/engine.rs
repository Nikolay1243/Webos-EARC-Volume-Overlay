//! Decides when to show the overlay and with which value. Pure logic, no I/O.

use std::time::{Duration, Instant};

use crate::Event;

/// How long to wait for the soundbar's answer to a key press before the
/// dimmed value is shown as final (e.g. a press at 0 or 100 that changes nothing).
const REPLY_WAIT: Duration = Duration::from_millis(1500);
/// Minimum gap between "key pressed" updates while a key is held.
const PENDING_REPEAT: Duration = Duration::from_millis(250);
/// Unrequested reports right after switching to ARC (wake, input change)
/// update the value silently instead of popping up the overlay.
const QUIET_AFTER_SWITCH: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Show {
    pub volume: u8,
    pub mute: bool,
    /// True when the soundbar has not yet confirmed the latest key press.
    pub pending: bool,
}

#[derive(Default)]
pub struct Engine {
    arc: Option<bool>,
    volume: Option<u8>,
    mute: bool,
    awaiting: Option<Instant>,
    last_pending_show: Option<Instant>,
    quiet_until: Option<Instant>,
}

impl Engine {
    pub fn on_arc(&self) -> bool {
        self.arc == Some(true)
    }

    /// Unknown output counts as ARC: the CEC messages themselves only
    /// flow while an audio system is in use.
    fn allowed(&self) -> bool {
        self.arc != Some(false)
    }

    fn quiet(&self, now: Instant) -> bool {
        self.quiet_until.is_some_and(|t| now < t)
    }

    pub fn handle(&mut self, event: Event, now: Instant) -> Option<Show> {
        match event {
            Event::Key(_) => {
                if !self.allowed() {
                    return None;
                }
                self.awaiting = Some(now);
                let volume = self.volume?;
                if self.last_pending_show.is_some_and(|t| now.duration_since(t) < PENDING_REPEAT) {
                    return None;
                }
                self.last_pending_show = Some(now);
                Some(Show { volume, mute: self.mute, pending: true })
            }
            Event::Report { volume, mute } => {
                let changed = self.volume.is_some_and(|v| v != volume) || (self.volume.is_some() && self.mute != mute);
                self.volume = Some(volume);
                self.mute = mute;
                let asked = self.awaiting.take().is_some_and(|t| now.duration_since(t) < REPLY_WAIT);
                self.last_pending_show = None;
                if self.allowed() && (asked || (changed && !self.quiet(now))) {
                    Some(Show { volume, mute, pending: false })
                } else {
                    None
                }
            }
            Event::Output(arc) => {
                let was = self.arc;
                self.arc = Some(arc);
                if arc && was != Some(true) {
                    if was == Some(false) {
                        // The soundbar may have changed while not in use.
                        self.volume = None;
                    }
                    self.quiet_until = Some(now + QUIET_AFTER_SWITCH);
                }
                if !arc {
                    self.awaiting = None;
                    self.last_pending_show = None;
                }
                None
            }
            Event::Seed(volume) => {
                if self.volume.is_none() {
                    self.volume = Some(volume);
                }
                None
            }
        }
    }

    /// Called when `next_deadline` passes without an event.
    pub fn tick(&mut self, now: Instant) -> Option<Show> {
        let since = self.awaiting?;
        if now.duration_since(since) < REPLY_WAIT {
            return None;
        }
        self.awaiting = None;
        self.last_pending_show = None;
        if !self.allowed() {
            return None;
        }
        Some(Show { volume: self.volume?, mute: self.mute, pending: false })
    }

    pub fn next_deadline(&self, now: Instant) -> Option<Duration> {
        self.awaiting.map(|t| (t + REPLY_WAIT).saturating_duration_since(now))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Key;

    fn ms(base: Instant, n: u64) -> Instant {
        base + Duration::from_millis(n)
    }

    fn ready(t0: Instant, volume: u8) -> Engine {
        let mut e = Engine::default();
        e.handle(Event::Output(true), t0);
        e.handle(Event::Seed(volume), t0);
        e
    }

    #[test]
    fn key_shows_dimmed_then_confirmed() {
        let t0 = Instant::now();
        let mut e = ready(t0, 16);
        let t = ms(t0, 5000);
        assert_eq!(e.handle(Event::Key(Key::VolumeDown), t), Some(Show { volume: 16, mute: false, pending: true }));
        assert_eq!(
            e.handle(Event::Report { volume: 14, mute: false }, ms(t, 600)),
            Some(Show { volume: 14, mute: false, pending: false })
        );
    }

    #[test]
    fn same_value_reply_to_key_is_still_shown() {
        let t0 = Instant::now();
        let mut e = ready(t0, 100);
        let t = ms(t0, 5000);
        e.handle(Event::Key(Key::VolumeUp), t);
        assert!(e.handle(Event::Report { volume: 100, mute: false }, ms(t, 500)).is_some());
    }

    #[test]
    fn soundbar_remote_change_is_shown_without_key() {
        let t0 = Instant::now();
        let mut e = ready(t0, 16);
        let r = e.handle(Event::Report { volume: 18, mute: false }, ms(t0, 9000));
        assert_eq!(r, Some(Show { volume: 18, mute: false, pending: false }));
        assert_eq!(e.handle(Event::Report { volume: 18, mute: false }, ms(t0, 9500)), None);
        assert!(e.handle(Event::Report { volume: 18, mute: true }, ms(t0, 9600)).is_some());
    }

    #[test]
    fn unanswered_key_is_finalised() {
        let t0 = Instant::now();
        let mut e = ready(t0, 0);
        let t = ms(t0, 5000);
        e.handle(Event::Key(Key::VolumeDown), t);
        assert_eq!(e.tick(ms(t, 1000)), None);
        assert_eq!(e.tick(ms(t, 1500)), Some(Show { volume: 0, mute: false, pending: false }));
        assert_eq!(e.next_deadline(ms(t, 1600)), None);
    }

    #[test]
    fn held_key_is_rate_limited() {
        let t0 = Instant::now();
        let mut e = ready(t0, 20);
        let t = ms(t0, 5000);
        assert!(e.handle(Event::Key(Key::VolumeUp), t).is_some());
        assert!(e.handle(Event::Key(Key::VolumeUp), ms(t, 100)).is_none());
        assert!(e.handle(Event::Key(Key::VolumeUp), ms(t, 300)).is_some());
    }

    #[test]
    fn nothing_when_not_on_arc_and_quiet_after_switch() {
        let t0 = Instant::now();
        let mut e = ready(t0, 20);
        e.handle(Event::Output(false), ms(t0, 1000));
        assert_eq!(e.handle(Event::Key(Key::VolumeUp), ms(t0, 2000)), None);
        assert_eq!(e.handle(Event::Report { volume: 30, mute: false }, ms(t0, 2100)), None);
        e.handle(Event::Output(true), ms(t0, 3000));
        // Value was cleared on the switch; first report only seeds it.
        assert_eq!(e.handle(Event::Report { volume: 25, mute: false }, ms(t0, 3500)), None);
        assert_eq!(e.handle(Event::Report { volume: 26, mute: false }, ms(t0, 4000)), None);
        assert!(e.handle(Event::Report { volume: 27, mute: false }, ms(t0, 8000)).is_some());
    }

    #[test]
    fn key_before_any_value_waits_for_report() {
        let t0 = Instant::now();
        let mut e = Engine::default();
        assert_eq!(e.handle(Event::Key(Key::VolumeUp), t0), None);
        assert!(e.handle(Event::Report { volume: 9, mute: false }, ms(t0, 600)).is_some());
    }
}

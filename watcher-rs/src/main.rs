//! eARC volume watcher for rooted LG webOS TVs.
//!
//! Volume and mute come straight from the soundbar's HDMI-CEC Report Audio
//! Status messages, read from the TV's CEC log as they are written. A volume
//! key press shows the overlay at once with the last known level (dimmed);
//! the soundbar's reply, which can take ~600 ms, fills in the real number.

mod cec;
mod engine;
mod luna;

use std::fs::OpenOptions;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub use engine::{Engine, Show};

const APP_ID: &str = "com.github.nikolay1243.earcvolume";
const LOG_PATH: &str = "/tmp/earc-volume-overlay.log";
const CEC_LOG: &str = "/var/log/cecmessages";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    VolumeUp,
    VolumeDown,
    Mute,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// The TV sent a volume or mute key to the soundbar.
    Key(Key),
    /// The soundbar reported its volume and mute state.
    Report { volume: u8, mute: bool },
    /// Sound output changed; true when it is the ARC/eARC device.
    Output(bool),
    /// Starting value read from webOS; never shown on its own.
    Seed(u8),
    /// Whether the TV's CEC log exists.
    CecLog(bool),
    /// webOS's stored copy of the soundbar's last reported volume, polled
    /// only when the CEC log cannot supply reports.
    Polled(u8),
    /// The TV's master volume or mute changed. Used only as an activity
    /// trigger (and for mute) while polling; its number is never shown.
    Master { mute: bool },
}

static DEBUG: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

pub fn log(message: &str) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(LOG_PATH) {
        let _ = writeln!(file, "{}.{:03} {}", now.as_secs(), now.subsec_millis(), message);
    }
}

pub fn debug(message: &str) {
    if *DEBUG.get().unwrap_or(&false) {
        log(message);
    }
}

/// Holds only the newest overlay update while a launch is in flight, so
/// held keys never queue stale values or run concurrent luna-send calls.
struct Launcher {
    slot: Mutex<Option<Show>>,
    ready: Condvar,
}

impl Launcher {
    fn start() -> Arc<Launcher> {
        let launcher = Arc::new(Launcher { slot: Mutex::new(None), ready: Condvar::new() });
        let worker = launcher.clone();
        std::thread::spawn(move || loop {
            let show = {
                let mut slot = worker.slot.lock().unwrap();
                while slot.is_none() {
                    slot = worker.ready.wait(slot).unwrap();
                }
                slot.take().unwrap()
            };
            luna::launch(&payload(&show));
        });
        launcher
    }

    fn show(&self, show: Show) {
        *self.slot.lock().unwrap() = Some(show);
        self.ready.notify_one();
    }
}

fn payload(show: &Show) -> String {
    format!(
        "{{\"id\":\"{}\",\"params\":{{\"volume\":{},\"mute\":{},\"pending\":{},\"output\":\"external_arc\"}}}}",
        APP_ID, show.volume, show.mute, show.pending
    )
}

fn seed(tx: Sender<Event>) {
    std::thread::spawn(move || {
        if let Some(volume) = luna::arc_volume() {
            let _ = tx.send(Event::Seed(volume));
        }
    });
}

/// Fallback reader for TVs whose CEC log has no soundbar reports: polls
/// webOS's stored ARC volume, every 150 ms around activity and every second
/// otherwise, and backs off when the soundbar reports nothing at all.
struct Poller {
    enabled: Arc<AtomicBool>,
    wake: Sender<()>,
}

impl Poller {
    const ACTIVE: Duration = Duration::from_millis(150);
    const ACTIVE_FOR: Duration = Duration::from_millis(2500);
    const IDLE: Duration = Duration::from_secs(1);
    const BACKOFF: Duration = Duration::from_secs(10);
    const FAILURES_BEFORE_BACKOFF: u32 = 5;

    fn start(tx: Sender<Event>) -> Poller {
        let enabled = Arc::new(AtomicBool::new(false));
        let (wake, woken) = channel::<()>();
        let flag = enabled.clone();
        std::thread::spawn(move || {
            let mut active_until = Instant::now();
            let mut failures = 0u32;
            loop {
                let interval = if !flag.load(Ordering::Relaxed) {
                    Duration::from_secs(3600)
                } else if Instant::now() < active_until {
                    Self::ACTIVE
                } else if failures >= Self::FAILURES_BEFORE_BACKOFF {
                    Self::BACKOFF
                } else {
                    Self::IDLE
                };
                match woken.recv_timeout(interval) {
                    Ok(()) => {
                        while woken.try_recv().is_ok() {}
                        active_until = Instant::now() + Self::ACTIVE_FOR;
                        failures = 0;
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
                if !flag.load(Ordering::Relaxed) {
                    continue;
                }
                match luna::arc_volume() {
                    Some(volume) => {
                        failures = 0;
                        if tx.send(Event::Polled(volume)).is_err() {
                            return;
                        }
                    }
                    None => failures = failures.saturating_add(1),
                }
            }
        });
        Poller { enabled, wake }
    }

    fn set_enabled(&self, on: bool) {
        if self.enabled.swap(on, Ordering::Relaxed) != on {
            log(if on {
                "no soundbar reports in the CEC log; reading stored ARC volume instead"
            } else {
                "soundbar reports available in the CEC log; stopped polling"
            });
            if on {
                let _ = self.wake.send(());
            }
        }
    }

    fn activity(&self) {
        if self.enabled.load(Ordering::Relaxed) {
            let _ = self.wake.send(());
        }
    }
}

fn main() {
    if std::env::args().any(|a| a == "--version") {
        println!("earc-watcher {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let _ = DEBUG.set(std::env::var("EARC_VOLUME_DEBUG").map(|v| v == "1").unwrap_or(false));
    log(&format!("earc-watcher {} starting (soundbar CEC reports)", env!("CARGO_PKG_VERSION")));

    let (tx, rx) = channel();
    {
        let tx = tx.clone();
        std::thread::spawn(move || cec::follow(CEC_LOG, tx));
    }
    {
        let tx = tx.clone();
        std::thread::spawn(move || luna::follow_sound_output(tx));
    }
    seed(tx.clone());

    let launcher = Launcher::start();
    let poller = Poller::start(tx.clone());
    let mut engine = Engine::default();
    loop {
        let wait = engine.next_deadline(Instant::now()).unwrap_or(Duration::from_secs(3600));
        let result = match rx.recv_timeout(wait) {
            Ok(event) => {
                match event {
                    Event::Output(true) if !engine.on_arc() => {
                        log("sound output is ARC/eARC");
                        seed(tx.clone());
                    }
                    Event::Output(false) if engine.on_arc() => log("sound output is not ARC/eARC"),
                    Event::CecLog(present) => log(if present { "CEC log available" } else { "CEC log not found" }),
                    Event::Key(_) | Event::Master { .. } => poller.activity(),
                    _ => {}
                }
                engine.handle(event, Instant::now())
            }
            Err(RecvTimeoutError::Timeout) => engine.tick(Instant::now()),
            Err(RecvTimeoutError::Disconnected) => break,
        };
        poller.set_enabled(engine.wants_polling());
        if let Some(show) = result {
            debug(&format!("show {:?}", show));
            launcher.show(show);
        }
    }
}

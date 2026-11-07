//! Reads the TV's own CEC message log. Nothing is sent on the CEC bus.
//!
//! Relevant lines on an LG C3 look like:
//!   2026-11-07T07:44:24.384197Z [CECMSG] TM91432 TX054442   (TV -> soundbar: volume down key)
//!   2026-11-07T07:44:24.987624Z [CECMSG] TM325715 RX507A0E  (soundbar -> TV: Report Audio Status, 14)

use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::sync::mpsc::Sender;
use std::time::Duration;

use crate::{debug, log, Event, Key};

const MAX_BACKLOG: u64 = 65536;

/// Parses one log line into an event, if it is one we care about.
pub fn parse_line(line: &str) -> Option<Event> {
    for token in line.split_ascii_whitespace() {
        // Report Audio Status from the audio system (5) to the TV (0).
        // Operand: bit 7 = mute, bits 0-6 = volume 0-100 (0x7F = unknown).
        if let Some(hex) = token.strip_prefix("RX507A") {
            let byte = parse_hex_byte(hex)?;
            let volume = byte & 0x7F;
            if volume > 100 {
                return None;
            }
            return Some(Event::Report { volume, mute: byte & 0x80 != 0 });
        }
        // User Control Pressed from the TV (0) to the audio system (5).
        if let Some(hex) = token.strip_prefix("TX0544") {
            return match parse_hex_byte(hex)? {
                0x41 => Some(Event::Key(Key::VolumeUp)),
                0x42 => Some(Event::Key(Key::VolumeDown)),
                0x43 | 0x65 | 0x66 => Some(Event::Key(Key::Mute)),
                _ => None,
            };
        }
    }
    None
}

fn parse_hex_byte(s: &str) -> Option<u8> {
    if s.len() != 2 {
        return None;
    }
    u8::from_str_radix(s, 16).ok()
}

struct Inotify {
    fd: i32,
}

impl Inotify {
    /// Watches the log's directory so rotation and re-creation are seen too.
    fn new(dir: &str) -> Option<Inotify> {
        let fd = unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) };
        if fd < 0 {
            return None;
        }
        let path = CString::new(dir).ok()?;
        let mask = libc::IN_MODIFY | libc::IN_CREATE | libc::IN_MOVED_TO | libc::IN_CLOSE_WRITE;
        if unsafe { libc::inotify_add_watch(fd, path.as_ptr(), mask) } < 0 {
            unsafe { libc::close(fd) };
            return None;
        }
        Some(Inotify { fd })
    }

    /// Blocks until the named file changes or the timeout passes.
    fn wait(&self, name: &[u8], timeout_ms: i32) {
        loop {
            let mut pfd = libc::pollfd { fd: self.fd, events: libc::POLLIN, revents: 0 };
            let ready = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
            if ready <= 0 {
                return;
            }
            let mut buf = [0u8; 4096];
            let n = unsafe { libc::read(self.fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
            if n <= 0 {
                return;
            }
            let mut offset = 0usize;
            let header = std::mem::size_of::<libc::inotify_event>();
            let mut hit = false;
            while offset + header <= n as usize {
                let event = unsafe { &*(buf.as_ptr().add(offset) as *const libc::inotify_event) };
                let len = event.len as usize;
                let raw = &buf[offset + header..(offset + header + len).min(n as usize)];
                let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
                if &raw[..end] == name {
                    hit = true;
                }
                offset += header + len;
            }
            if hit {
                return;
            }
            // Another file in the directory changed; keep waiting.
        }
    }
}

/// Follows the log forever, sending parsed events. Starts at the end of the
/// file so old entries are never replayed.
pub fn follow(path: &str, tx: Sender<Event>) {
    let (dir, name) = match path.rfind('/') {
        Some(i) => (&path[..i.max(1)], &path.as_bytes()[i + 1..]),
        None => (".", path.as_bytes()),
    };
    let watcher = Inotify::new(dir);
    if watcher.is_none() {
        log("inotify unavailable; polling the CEC log every 150 ms");
    }

    let (mut position, mut inode) = match std::fs::metadata(path) {
        Ok(m) => (m.len(), m.ino()),
        Err(_) => {
            log("CEC log not found yet; waiting for it to appear");
            (0, 0)
        }
    };
    let mut pending: Vec<u8> = Vec::new();

    loop {
        match &watcher {
            Some(w) => w.wait(name, 1000),
            None => std::thread::sleep(Duration::from_millis(150)),
        }
        let Ok(mut file) = File::open(path) else { continue };
        let Ok(meta) = file.metadata() else { continue };
        if meta.ino() != inode || meta.len() < position {
            // Rotated or truncated: the new file holds only new lines.
            position = 0;
            pending.clear();
            inode = meta.ino();
        }
        if meta.len() - position > MAX_BACKLOG {
            position = meta.len() - MAX_BACKLOG;
            pending.clear();
        }
        if meta.len() == position || file.seek(SeekFrom::Start(position)).is_err() {
            continue;
        }
        let mut chunk = Vec::with_capacity((meta.len() - position) as usize);
        let Ok(count) = file.read_to_end(&mut chunk) else { continue };
        position += count as u64;
        pending.extend_from_slice(&chunk);

        let mut start = 0;
        while let Some(i) = pending[start..].iter().position(|&b| b == b'\n') {
            let line = String::from_utf8_lossy(&pending[start..start + i]);
            if let Some(event) = parse_line(&line) {
                debug(&format!("cec: {}", line.trim()));
                if tx.send(event).is_err() {
                    return;
                }
            }
            start += i + 1;
        }
        pending.drain(..start);
        if pending.len() > MAX_BACKLOG as usize {
            pending.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_c3_lines() {
        let report = parse_line("2026-11-07T07:44:24.987624Z [CECMSG] TM325715 RX507A0E");
        assert_eq!(report, Some(Event::Report { volume: 14, mute: false }));
        let key = parse_line("2026-11-07T07:44:24.384197Z [CECMSG] TM91432 TX054442");
        assert_eq!(key, Some(Event::Key(Key::VolumeDown)));
        assert_eq!(parse_line("[CECMSG] TX054441"), Some(Event::Key(Key::VolumeUp)));
        assert_eq!(parse_line("[CECMSG] TX054443"), Some(Event::Key(Key::Mute)));
    }

    #[test]
    fn decodes_mute_bit_and_rejects_unknown() {
        assert_eq!(parse_line("[CECMSG] RX507A91"), Some(Event::Report { volume: 17, mute: true }));
        assert_eq!(parse_line("[CECMSG] RX507A7F"), None);
        assert_eq!(parse_line("[CECMSG] RX507AFF"), None);
    }

    #[test]
    fn ignores_other_messages() {
        assert_eq!(parse_line("[CECMSG] TX0545"), None);
        assert_eq!(parse_line("[CECMSG] RX5F7210"), None);
        assert_eq!(parse_line("[CECMSG] RX507A0E00"), None);
        assert_eq!(parse_line("[CECMSG] RX407A10"), None);
        assert_eq!(parse_line(""), None);
    }
}

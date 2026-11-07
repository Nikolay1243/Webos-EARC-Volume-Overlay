//! Talks to webOS services through luna-send. Only one long-lived process is
//! used (the sound-output subscription); one-shot calls are rare.

use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

use crate::{debug, log, Event};

const LUNA_SEND: &str = "/usr/bin/luna-send";
const SCRIPT: &str = "/usr/bin/script";

/// Children die with the watcher instead of being orphaned.
fn command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null()).stderr(Stdio::null());
    unsafe {
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
    cmd
}

/// luna-send needs a terminal on these TVs, so it runs under `script`.
fn under_pty(luna_args: &str, flush: bool) -> Command {
    let mut cmd = command(SCRIPT);
    cmd.arg("-q");
    if flush {
        cmd.arg("-f");
    }
    cmd.args(["-c", &format!("{} {}", LUNA_SEND, luna_args), "/dev/null"]);
    cmd
}

fn wait_with_timeout(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Extracts a string field from a flat-enough JSON line.
pub fn string_field<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let at = json.find(&format!("\"{}\"", key))? + key.len() + 2;
    let rest = json[at..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    Some(&rest[..rest.find('"')?])
}

/// Extracts a non-negative integer field.
pub fn number_field(json: &str, key: &str) -> Option<u32> {
    let at = json.find(&format!("\"{}\"", key))? + key.len() + 2;
    let rest = json[at..].trim_start().strip_prefix(':')?.trim_start();
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    rest[..end].parse().ok()
}

/// Tracks whether sound goes to the ARC/eARC device. Restarts if it exits.
pub fn follow_sound_output(tx: Sender<Event>) {
    let args = "-i 'luna://com.webos.service.audio/master/getVolume' '{\"subscribe\":true}'";
    loop {
        match under_pty(args, true).stdout(Stdio::piped()).spawn() {
            Ok(mut child) => {
                let stdout = child.stdout.take().expect("piped stdout");
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    let line = line.trim();
                    if !line.starts_with('{') {
                        continue;
                    }
                    if line.contains("\"returnValue\":false") {
                        log(&format!("audio subscription rejected: {}", line));
                        continue;
                    }
                    if let Some(output) = string_field(line, "soundOutput") {
                        if tx.send(Event::Output(output == "external_arc")).is_err() {
                            let _ = child.kill();
                            return;
                        }
                    }
                }
                let _ = child.kill();
                let _ = child.wait();
                log("audio subscription ended; restarting");
            }
            Err(e) => log(&format!("cannot start audio subscription: {}", e)),
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// One-shot read of the last volume the soundbar reported to webOS.
pub fn arc_volume() -> Option<u8> {
    let args = "-n 1 'luna://com.webos.service.eim/getArcVolume' '{}'";
    let mut child = under_pty(args, false).stdout(Stdio::piped()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut text);
        text
    });
    wait_with_timeout(&mut child, Duration::from_millis(2000));
    let text = reader.join().ok()?;
    let volume = number_field(&text, "Volume")?;
    if volume <= 100 { Some(volume as u8) } else { None }
}

/// Launches (or relaunches) the overlay app with new parameters.
pub fn launch(payload: &str) -> bool {
    let started = Instant::now();
    let child = command(LUNA_SEND)
        .args(["-n", "1", "luna://com.webos.applicationManager/launch", payload])
        .stdout(Stdio::null())
        .spawn();
    let ok = match child {
        Ok(mut child) => wait_with_timeout(&mut child, Duration::from_millis(3000)),
        Err(_) => false,
    };
    if ok {
        debug(&format!("launch took {} ms", started.elapsed().as_millis()));
    } else {
        log("overlay launch failed");
    }
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_fields() {
        let line = r#"{"returnValue":true,"volumeStatus":{"volume":12,"muteStatus":false,"soundOutput":"external_arc"},"subscribed":true}"#;
        assert_eq!(string_field(line, "soundOutput"), Some("external_arc"));
        assert_eq!(number_field(line, "volume"), Some(12));
        assert_eq!(number_field(r#"{ "Volume" : 27 }"#, "Volume"), Some(27));
        assert_eq!(string_field(line, "missing"), None);
    }
}

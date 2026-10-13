//! Hybrid logical clock: wall time in milliseconds, a counter, and the device id.
//!
//! Every change carries one. They order changes for "the latest one wins": first by time, then
//! by counter, then by device id, so two devices never tie. A device that sees a change from the
//! future (a clock set wrong) moves its own clock past it, so its next change still comes later.
//! A wrong clock can make one change win early, but it can't keep winning.

use std::{cmp::Ordering, fmt, str::FromStr};

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub struct Hlc {
    /// Milliseconds since 1970 (UTC).
    pub wall: u64,
    pub counter: u32,
    pub device: String,
}

impl Ord for Hlc {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.wall, self.counter, &self.device).cmp(&(other.wall, other.counter, &other.device))
    }
}

impl PartialOrd for Hlc {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Written as `<wall>.<counter>.<device>`, e.g. `1760280000000.0.3f2a…`.
impl fmt::Display for Hlc {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.wall, self.counter, self.device)
    }
}

impl FromStr for Hlc {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let mut parts = s.splitn(3, '.');
        let (Some(wall), Some(counter), Some(device)) = (parts.next(), parts.next(), parts.next()) else {
            return Err(format!("not a clock value: {s}"));
        };
        let wall = wall.parse().map_err(|_| format!("not a clock value: {s}"))?;
        let counter = counter.parse().map_err(|_| format!("not a clock value: {s}"))?;
        if !super::is_device_id(device) {
            return Err(format!("not a clock value: {s}"));
        }
        Ok(Hlc { wall, counter, device: device.to_string() })
    }
}

impl Serialize for Hlc {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Hlc {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(de::Error::custom)
    }
}

/// One device's clock.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Clock {
    /// The latest value given out or seen.
    pub last_wall: u64,
    pub last_counter: u32,
}

impl Clock {
    /// The next value for a change made now. Always later than anything given out or seen.
    pub fn tick(&mut self, device: &str, now_ms: u64) -> Hlc {
        if now_ms > self.last_wall {
            self.last_wall = now_ms;
            self.last_counter = 0;
        } else {
            self.last_counter = self.last_counter.saturating_add(1);
        }
        Hlc { wall: self.last_wall, counter: self.last_counter, device: device.to_string() }
    }

    /// Takes note of a change from another device, so the next `tick` comes after it.
    pub fn observe(&mut self, seen: &Hlc) {
        if (seen.wall, seen.counter) > (self.last_wall, self.last_counter) {
            self.last_wall = seen.wall;
            self.last_counter = seen.counter;
        }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

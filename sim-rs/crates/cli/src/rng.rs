//! 确定性伪随机数生成器（SplitMix64，自研）。
//!
//! PARITY.md §8：Go math/rand 序列与 Rust 不可共用——simsearch/optsearch
//! 用本 RNG 保证 **Rust 内部**确定性（同 seed 同序列），不与 Go 输出
//! 逐字节对齐（随机场景生成是探索工具，非契约）。

/// SplitMix64：小状态、快、确定性（标准 SplitMix64 算法）。
#[derive(Debug, Clone, Copy)]
pub struct SplitMix64(u64);

impl SplitMix64 {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// [0, bound) 区间整数。
    pub fn next_int(&mut self, bound: i64) -> i64 {
        (self.next_u64() % bound as u64) as i64
    }

    /// [0, 1) 区间浮点。
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_sequence() {
        let mut a = SplitMix64::new(42);
        let mut b = SplitMix64::new(42);
        for _ in 0..100 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn bounds_respected() {
        let mut rng = SplitMix64::new(7);
        for _ in 0..1000 {
            let v = rng.next_int(10);
            assert!((0..10).contains(&v));
        }
    }

    #[test]
    fn different_seeds_diverge() {
        let mut a = SplitMix64::new(1);
        let mut b = SplitMix64::new(2);
        assert_ne!(a.next_u64(), b.next_u64());
    }
}

// Fixture: clamp -- if/else chain
// Expected output:
//   pub fn clamp(x: i32, lo: i32, hi: i32) -> i32 {
//       if x < lo {
//           return lo;
//       } else if x > hi {
//           return hi;
//       } else {
//           return x;
//       }
//   }
export function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) {
    return lo;
  }
  if (x > hi) {
    return hi;
  }
  return x;
}

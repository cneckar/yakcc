// Fixture: double -- let binding
// Expected output:
//   pub fn double(x: i32) -> i32 {
//       let result = x * 2;
//       return result;
//   }
export function double(x: number): number {
  const result = x * 2;
  return result;
}

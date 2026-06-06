// Fixture: greet -- string return
// Expected output:
//   pub fn greet(name: String) -> String {
//       return "hello".to_string();
//   }
// Note: string concatenation with + requires owned String on both sides in Rust.
// For MVP, simple string return is the target.
export function greet(): string {
  return "hello";
}

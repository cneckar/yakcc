export let count = 0;
export function bump(k: number): void {
  count = count + k;
}
export default function current(): number {
  return count * 10;
}

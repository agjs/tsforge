// tier: copper
import { oldApi } from "./api";

export function run(): string {
  return oldApi("ping");
}

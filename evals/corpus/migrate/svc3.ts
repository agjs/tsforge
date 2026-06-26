// tier: bronze
import { oldApi } from "./api";

export function run(): string {
  return oldApi("ping");
}

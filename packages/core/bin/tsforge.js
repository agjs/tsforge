#!/usr/bin/env bun
import { main } from "../src/cli.ts";

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    process.stderr.write(
      `tsforge: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  });

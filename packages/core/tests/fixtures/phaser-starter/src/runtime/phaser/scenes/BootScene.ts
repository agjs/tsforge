import * as Phaser from "phaser";

import { BOOT_SCENE_KEY, WORLD_SCENE_KEY } from "./keys";

export class BootScene extends Phaser.Scene {
  constructor() {
    super(BOOT_SCENE_KEY);
  }

  create(): void {
    this.scene.start(WORLD_SCENE_KEY);
  }
}

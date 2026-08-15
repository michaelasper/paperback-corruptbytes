import type { ExtensionImpl } from "@paperback/types";

import { NovelDashExtension } from "../shared/noveldash-main.js";
import type DivaScansConfig from "./pbconfig.js";
import { DIVA_SCANS_SITE } from "./site.js";

export class DivaScansExtension
  extends NovelDashExtension
  implements ExtensionImpl<typeof DivaScansConfig>
{
  constructor() {
    super(DIVA_SCANS_SITE);
  }
}

export const DivaScans = new DivaScansExtension();

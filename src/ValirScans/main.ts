import type { ExtensionImpl } from "@paperback/types";

import { NovelDashExtension } from "../shared/noveldash-main.js";
import type ValirScansConfig from "./pbconfig.js";
import { VALIR_SCANS_SITE } from "./site.js";

export class ValirScansExtension
  extends NovelDashExtension
  implements ExtensionImpl<typeof ValirScansConfig>
{
  constructor() {
    super(VALIR_SCANS_SITE);
  }
}

export const ValirScans = new ValirScansExtension();

import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";

export default {
  name: "Atsumaru",
  description:
    "Read Atsumaru comics and novels anonymously with complete discovery, advanced taxonomy search, and stable scanlation-aware chapter IDs.",
  version: "1.0.0-alpha.5",
  icon: "icon.png",
  language: "en",
  contentRating: ContentRating.ADULT,
  capabilities: [
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
    SourceIntents.DISCOVER_SECTION_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.SETTINGS_FORM_PROVIDING,
  ],
  badges: [
    { label: "Archive compatible", textColor: "#FFFFFF", backgroundColor: "#22543D" },
    { label: "Comics + novels", textColor: "#FFFFFF", backgroundColor: "#343A40" },
  ],
  developers: [
    {
      name: "corruptbytes",
      website: "https://github.com/michaelasper/paperback-corruptbytes",
      github: "https://github.com/michaelasper",
    },
  ],
} satisfies ExtensionInfo;

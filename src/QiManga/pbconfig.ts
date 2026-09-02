import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";

export default {
  name: "Qi Manga",
  description:
    "Qi Manga comics and novels with complete discovery, live filters, stable IDs, and first-party access to purchased chapters.",
  version: "1.0.0-alpha.2",
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
    { label: "Comics + novels", textColor: "#FFFFFF", backgroundColor: "#6521A8" },
    { label: "Account-aware", textColor: "#FFFFFF", backgroundColor: "#374151" },
  ],
  developers: [
    {
      name: "corruptbytes",
      website: "https://github.com/michaelasper/paperback-corruptbytes",
      github: "https://github.com/michaelasper",
    },
  ],
} satisfies ExtensionInfo;

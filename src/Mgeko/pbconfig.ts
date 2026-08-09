import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";

export default {
  name: "Mgeko",
  description:
    "A high-reliability Mgeko extension with complete discovery, safe-mode search, advanced filters, and stable chapter IDs.",
  version: "1.0.0-alpha.1",
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
    { label: "Stable", textColor: "#FFFFFF", backgroundColor: "#22543D" },
    { label: "Advanced search", textColor: "#FFFFFF", backgroundColor: "#4A5568" },
  ],
  developers: [
    {
      name: "corruptbytes",
      website: "https://github.com/michaelasper/paperback-corruptbytes",
      github: "https://github.com/michaelasper",
    },
  ],
} satisfies ExtensionInfo;

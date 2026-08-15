import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";

export default {
  name: "MadaraDex",
  description:
    "A high-reliability MadaraDex extension with stable numeric IDs, automatic reader authorization, full discovery, and advanced search.",
  version: "1.0.0-alpha.7",
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
    { label: "Stable IDs", textColor: "#FFFFFF", backgroundColor: "#22543D" },
    { label: "Automatic auth", textColor: "#FFFFFF", backgroundColor: "#4A5568" },
  ],
  developers: [
    {
      name: "corruptbytes",
      website: "https://github.com/michaelasper/paperback-corruptbytes",
      github: "https://github.com/michaelasper",
    },
  ],
} satisfies ExtensionInfo;

import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";

export default {
  name: "Rokari Comics",
  description:
    "Rokari Comics manhwa with fast catalog search, complete inline chapter lists, and direct image readers.",
  version: "1.0.0-alpha.3",
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
    { label: "Complete chapters", textColor: "#FFFFFF", backgroundColor: "#0D9488" },
    { label: "Manhwa", textColor: "#FFFFFF", backgroundColor: "#374151" },
  ],
  developers: [
    {
      name: "corruptbytes",
      website: "https://github.com/michaelasper/paperback-corruptbytes",
      github: "https://github.com/michaelasper",
    },
  ],
} satisfies ExtensionInfo;

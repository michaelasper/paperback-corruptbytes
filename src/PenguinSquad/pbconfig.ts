import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";

export default {
  name: "Penguin Squad",
  description:
    "Penguin Squad translated novels with the complete public catalog, full chapter histories, and readable public chapters.",
  version: "1.0.1",
  icon: "icon.png",
  language: "en",
  contentRating: ContentRating.ADULT,
  capabilities: [
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.DISCOVER_SECTION_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
  ],
  badges: [
    { label: "Novels", textColor: "#FFFFFF", backgroundColor: "#0F766E" },
    { label: "Complete chapters", textColor: "#FFFFFF", backgroundColor: "#374151" },
  ],
  developers: [
    {
      name: "corruptbytes",
      website: "https://github.com/michaelasper/paperback-corruptbytes",
      github: "https://github.com/michaelasper",
    },
  ],
} satisfies ExtensionInfo;

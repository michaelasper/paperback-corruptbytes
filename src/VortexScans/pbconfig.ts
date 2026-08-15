import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";

export default {
  name: "Vortex Scans",
  description:
    "Read Vortex Scans comics and purchased chapters using your first-party Vortex session.",
  version: "1.0.0-alpha.8",
  icon: "icon.png",
  language: "en",
  contentRating: ContentRating.MATURE,
  capabilities: [
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
    SourceIntents.DISCOVER_SECTION_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.SETTINGS_FORM_PROVIDING,
  ],
  badges: [],
  developers: [
    {
      name: "corruptbytes",
    },
  ],
} satisfies ExtensionInfo;

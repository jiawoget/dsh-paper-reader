import { createCitationMapView } from './citation-map-view.js';
import { createFieldTrendsView } from './field-trends-view.js';
import { createLibraryChatView } from './library-chat-view.js';
import type { ResearchWorkspace } from './workspace-shell.js';

export function registerResearchViews(workspace: ResearchWorkspace): void {
  workspace.registerView(createCitationMapView());
  workspace.registerView(createFieldTrendsView());
  workspace.registerView(createLibraryChatView());
}

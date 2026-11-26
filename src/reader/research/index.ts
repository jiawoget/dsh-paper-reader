import { createCitationMapView } from './citation-map-view.js';
import { createDeepSearchView } from './deep-search-view.js';
import { createFieldTrendsView } from './field-trends-view.js';
import { createLibraryChatView } from './library-chat-view.js';
import { createReviewTableView } from './review-table-view.js';
import type { ResearchWorkspace } from './workspace-shell.js';

export function registerResearchViews(workspace: ResearchWorkspace): void {
  workspace.registerView(createDeepSearchView());
  workspace.registerView(createCitationMapView());
  workspace.registerView(createFieldTrendsView());
  workspace.registerView(createLibraryChatView());
  workspace.registerView(createReviewTableView());
}

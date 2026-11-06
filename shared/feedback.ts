// Feedback form constants shared by the server and the browser client.
export const FEEDBACK_TYPES = ['bug', 'idea', 'other'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];
export const FEEDBACK_PAGES = ['home', 'room'] as const;
export type FeedbackPage = (typeof FEEDBACK_PAGES)[number];

export const FEEDBACK_LIMITS = {
  messageMin: 5,
  messageMax: 2000,
  contactMax: 120,
  viewportMax: 20,
  userAgentMax: 300,
  /** Request body cap in bytes (the server answers 413 above it). */
  bodyMax: 8192,
} as const;

export interface FeedbackRequest {
  type: FeedbackType;
  message: string;
  contact?: string;
  page: FeedbackPage;
  viewport?: string;
  userAgent?: string;
}

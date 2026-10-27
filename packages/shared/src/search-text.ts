import { z } from 'zod';

export const SEARCH_QUERY_MAX_LENGTH = 100;

/** Free text typed by a person; trimmed and bounded. Used by global and customer search. */
export const searchTextSchema = z
  .string({ error: 'Must be a single value' })
  .trim()
  .min(1, 'Type something to search for')
  .max(SEARCH_QUERY_MAX_LENGTH, `Searches can be at most ${SEARCH_QUERY_MAX_LENGTH} characters`);

// Shared between rewrite-execute (which actually enforces this) and any UI
// that displays/gates on "how many paragraphs are still eligible for
// rewrite" -- these must use identical logic. A count computed a different,
// looser way (e.g. a raw "never touched" DB count with no length/title
// filtering) will never converge to zero even after every truly-eligible
// paragraph has been processed, since short/title-echo paragraphs are
// permanently skipped server-side but would still show as "remaining".
export function shouldSkipParagraph(text: string, title: string | null) {
  const clean = text.trim();
  const words = clean.split(/\s+/).filter(Boolean).length;
  if (words < 8) return true;
  if (title && clean.toLowerCase() === title.trim().toLowerCase()) return true;
  return false;
}

export type ExistingRevisionRow = {
  paragraph_id: string | null;
  accepted: boolean | null;
  rejected: boolean | null;
  revision_job_id?: string | null;
};

// A paragraph can carry BOTH an old accepted revision and a newer pending
// one (e.g. immediately after a second rewrite pass touches it) -- pending
// status must win for eligibility, since that pending revision is exactly
// why the paragraph is no longer selectable via "rewriteAccepted" alone
// (it needs "rewriteExistingDrafts" instead). A naive "has ANY accepted
// revision" count (ignoring whether a newer pending one exists) never
// shrinks as a rewrite pass progresses, leaving a displayed "remaining"
// count frozen while the server correctly finds fewer and fewer eligible
// units underneath it.
export function getExistingRevisionState(revisions: ExistingRevisionRow[]) {
  const pendingDraftParagraphIds = new Set<string>();
  const acceptedParagraphIds = new Set<string>();

  revisions.forEach((revision) => {
    if (!revision.paragraph_id) return;
    if (revision.accepted) {
      acceptedParagraphIds.add(revision.paragraph_id);
      return;
    }
    if (!revision.rejected) {
      pendingDraftParagraphIds.add(revision.paragraph_id);
    }
  });

  // Pending wins when both exist: rewrite-execute's own eligibility loop
  // checks pendingDraftParagraphIds first and skips on a match regardless of
  // acceptedParagraphIds, so keeping the sets mutually exclusive here just
  // makes that same precedence visible to callers that only look at one set
  // (e.g. a UI showing "N accepted paragraphs remain eligible").
  for (const paragraphId of pendingDraftParagraphIds) {
    acceptedParagraphIds.delete(paragraphId);
  }

  return { pendingDraftParagraphIds, acceptedParagraphIds };
}

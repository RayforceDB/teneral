// The single internal reply for a clock tick on which there is nothing to say. It settles the
// journal turn and any waiting clock, but is not a message to the owner. Keep this exact: old
// journal readers must be able to recognise the whole reply, never a prefix of real prose.
export const QUIET_REPLY = '[teneral: no reply]';
export const ROUND_LIMIT_REPLY = '[round limit reached; waiting for the next stimulus]';
// What ends a turn that went on in calls that do nothing (brain/loop.ts). Shown: unlike a quiet tick, nothing settled it.
export const NO_OP_REPLY = '[stopped: only calls that do nothing; waiting for the next stimulus]';
// What ends a turn whose request stopped changing (brain/loop.ts): the agent was not being shown its own last steps. Shown, for the owner to see.
export const SAME_REQUEST_REPLY = '[stopped: the request stopped changing, so my last steps were not being shown to me; waiting for the next stimulus]';
export const quietReply = (text: string): boolean => {
  const rest = text.trim();
  if (rest === '') return false;
  // A model occasionally repeats the marker. It is still only an internal reply, never prose to
  // show; a marker next to any other words does not make the rest of the reply disappear.
  const markers = [QUIET_REPLY, ROUND_LIMIT_REPLY];
  let at = 0;
  while (at < rest.length) {
    const marker = markers.find(mark => rest.startsWith(mark, at));
    if (marker === undefined) return false;
    at += marker.length;
    while (at < rest.length && /\s/.test(rest[at]!)) at += 1;
  }
  return true;
};
/**
 * What stands before the marker when a reply ends with it on a line of its own, and null when it
 * does not end so. A model often says why it stays quiet and then signs off with the marker: the
 * marker is the answer, and the words before it are its reasons, not a message to anyone.
 * The marker first and prose after it is a reply, as above.
 */
export const quietEnd = (text: string): string | null => {
  const rest = text.trim();
  if (!rest.endsWith(QUIET_REPLY)) return null;
  const before = rest.slice(0, rest.length - QUIET_REPLY.length);
  if (before !== '' && !before.endsWith('\n')) return null;
  return before.trim();
};

/**
 * What the conversation screen says when a thread cannot be read.
 *
 * `/copilot?thread=thr_doesnotexist` printed the API's own line — "No such ai
 * thread: thr_doesnotexist" — a resource name and a primary key, to a person
 * who followed a stale link. The failure is real and the fact stays; the words
 * are the screen's, and the way out is a button.
 */

export interface ThreadErrorCopy {
  title: string;
  message: string;
  /** The label of the one action that always makes sense here. */
  action: 'start_new' | 'try_again';
}

export function threadErrorCopy(error: { status: number; message: string }): ThreadErrorCopy {
  if (error.status === 404) {
    return {
      title: 'This conversation no longer exists',
      message: 'It was deleted, or the link came from another workspace. Any runs behind it are still in the run log, with their traces and costs.',
      action: 'start_new',
    };
  }
  if (error.status === 403) {
    return {
      title: 'This conversation is not yours to read',
      message: 'It belongs to another workspace or another teammate’s key. Start one of your own instead.',
      action: 'start_new',
    };
  }
  return {
    title: 'This conversation could not be read',
    message: error.message,
    action: 'try_again',
  };
}

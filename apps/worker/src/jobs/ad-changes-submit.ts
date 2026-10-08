import {
  AmazonAdsHttpError,
  AmazonAdsReauthRequiredError,
  AmazonAdsWriteAbortedError,
  type AmazonAdsWriteResult,
} from '@profitbash/amazon-ads';
import {
  AD_CHANGE_NOT_SENT,
  AD_CHANGE_UNKNOWN_OUTCOME,
  claimNextAdChangeSubmission,
  ConnectionReauthRequiredError,
  errorLogFields,
  failOpenAdChangeSubmissions,
  findJobConnection,
  finishAdChangeSubmission,
  prepareAdChangeSubmission,
  recordAdChangeResults,
  type AdChangeResultInput,
} from '@profitbash/db';
import { buildWriteOperations } from '../ad-changes/operations';
import { JobFailure, type JobCounters, type JobOutcome } from '../run-job';
import {
  handleAmazonError,
  loadConnection,
  REAUTH_REQUIRED_MESSAGE,
  type ConnectionJobData,
  type ConnectionJobDeps,
  type ConnectionJobRun,
} from './connection-job';

const QUEUE = 'ad-changes-submit';

/** So oft wird eine gedrosselte Übermittlung abgeholt, bevor ihre ungesendeten Änderungen scheitern. */
export const MAX_SUBMISSION_ATTEMPTS = 5;
/** Laufzeit, nach der der Job vor der nächsten Übermittlung endet und sich neu einplant (wie die Datenjobs). */
export const SUBMIT_TIME_BUDGET_MS = 5 * 60_000;
/** Wartezeit nach einer Drosselung: mindestens, höchstens und ohne Angabe von Amazon. */
const MIN_RETRY_SECONDS = 60;
const MAX_RETRY_SECONDS = 60 * 60;

const UNKNOWN_HINT =
  'Ob Amazon die Änderung angewendet hat, ist unklar; nach dem nächsten Sync prüfen.';
const THROTTLED_NOTE = 'Amazon hat gedrosselt; der Rest wird automatisch erneut gesendet.';
const THROTTLED_GIVE_UP = 'Amazon hat wiederholt gedrosselt; die Änderungen wurden nicht gesendet.';

/**
 * `ad-changes-submit` je Connection (`docs/tasks/phase-3.md` 3.3): sendet die offenen Übermittlungen über die API
 * (älteste zuerst) und hält das Ergebnis je Änderung fest. Teilfehler brechen nicht ab. Gedrosselte Änderungen
 * bleiben offen und gehen im nächsten Lauf raus; ein Abbruch (kein Zugriff, Token abgelehnt) lässt den Rest der
 * Übermittlung scheitern, die Teilergebnisse bleiben. Unklare Ausgänge werden nicht wiederholt.
 */
export async function submitConnectionAdChanges(
  deps: ConnectionJobDeps,
  job: ConnectionJobData,
  run: ConnectionJobRun,
): Promise<JobOutcome> {
  const now = deps.now ?? (() => new Date());
  const ref = { organizationId: job.organizationId, connectionId: job.connectionId };
  const counters: JobCounters = {
    submissions: 0,
    changesApplied: 0,
    changesFailed: 0,
    changesUnsent: 0,
  };
  const failOpen = () =>
    failOpenAdChangeSubmissions(deps.db, {
      ...ref,
      now: now(),
      error: REAUTH_REQUIRED_MESSAGE,
      code: AD_CHANGE_NOT_SENT,
      message: `Nicht gesendet: ${REAUTH_REQUIRED_MESSAGE}`,
    });

  // Über eine Connection ohne gültige Einwilligung geht nichts raus: Die Übermittlungen blieben sonst liegen und
  // gingen nach dem Neu-Verbinden unerwartet raus.
  if ((await findJobConnection(deps.db, job))?.status === 'reauth_required') await failOpen();
  const connection = await loadConnection(deps.db, job);

  const startedAt = now().getTime();
  const done: string[] = [];
  let failure: string | null = null;
  for (;;) {
    if (done.length > 0 && now().getTime() - startedAt > SUBMIT_TIME_BUDGET_MS) {
      await deps.enqueue(QUEUE, ref);
      counters.continued = 1;
      break;
    }
    await run.extendLease();
    const submission = await claimNextAdChangeSubmission(deps.db, {
      ...ref,
      jobRunId: run.runId,
      now: now(),
      excludeIds: done,
    });
    if (!submission) break;
    done.push(submission.id);
    counters.submissions! += 1;
    const submissionRef = { organizationId: job.organizationId, submissionId: submission.id };
    const record = async (results: AdChangeResultInput[]) => {
      const recorded = await recordAdChangeResults(deps.db, {
        ...submissionRef,
        now: now(),
        results,
      });
      counters.changesApplied! += recorded.applied;
      counters.changesFailed! += recorded.failed;
      return recorded.applied + recorded.failed;
    };

    const rows = await prepareAdChangeSubmission(deps.db, submissionRef);
    const plan = buildWriteOperations(rows);
    let open = rows.length;
    open -= await record(
      plan.rejected.map(({ changeId, code, message }) => ({
        changeId,
        outcome: 'failed',
        code,
        message,
      })),
    );

    let retryAfterMs: number | null = null;
    let aborted: { cause: unknown } | null = null;
    for (const batch of plan.batches) {
      let results: readonly AmazonAdsWriteResult[];
      let throttled = false;
      try {
        const response = await deps.amazonAds.applyChanges(
          connection,
          {
            amazonProfileId: submission.amazonProfileId,
            adProduct: batch.adProduct,
            operations: batch.operations,
          },
          { meter: run.meter },
        );
        results = response.results;
        throttled = response.throttled;
        retryAfterMs = response.retryAfterMs ?? retryAfterMs;
      } catch (err) {
        if (!(err instanceof AmazonAdsWriteAbortedError)) throw err;
        // Was bis zum Abbruch feststeht, zuerst festhalten (schon angewendete Änderungen!).
        results = err.results;
        aborted = { cause: err.cause };
      }
      open -= await record(toChangeResults(results, plan.changeIdsByRef));
      if (aborted || throttled) break;
    }

    if (aborted) {
      const reauth =
        aborted.cause instanceof AmazonAdsReauthRequiredError ||
        aborted.cause instanceof ConnectionReauthRequiredError;
      const message = reauth ? REAUTH_REQUIRED_MESSAGE : abortMessage(aborted.cause);
      if (!reauth && !(aborted.cause instanceof AmazonAdsHttpError)) {
        deps.logger({
          level: 'error',
          msg: 'ad_changes_submit.aborted',
          submissionId: submission.id,
          ...errorLogFields(aborted.cause),
        });
      }
      await finishAdChangeSubmission(deps.db, {
        ...submissionRef,
        now: now(),
        error: message,
        failRemaining: { code: AD_CHANGE_NOT_SENT, message: `Nicht gesendet: ${message}` },
      });
      counters.changesFailed! += open;
      if (reauth) {
        await failOpen();
        return handleAmazonError(deps, QUEUE, job, connection, aborted.cause, counters);
      }
      // Kein Zugriff kann am Profil liegen: Die Übermittlungen anderer Profile laufen weiter.
      failure = message;
      continue;
    }

    if (open > 0) {
      if (submission.attempts >= MAX_SUBMISSION_ATTEMPTS) {
        await finishAdChangeSubmission(deps.db, {
          ...submissionRef,
          now: now(),
          error: THROTTLED_GIVE_UP,
          failRemaining: { code: AD_CHANGE_NOT_SENT, message: THROTTLED_GIVE_UP },
        });
        counters.changesFailed! += open;
        failure = THROTTLED_GIVE_UP;
        continue;
      }
      await finishAdChangeSubmission(deps.db, {
        ...submissionRef,
        now: now(),
        error: THROTTLED_NOTE,
      });
      counters.changesUnsent! += open;
      const seconds = Math.ceil((retryAfterMs ?? MIN_RETRY_SECONDS * 1000) / 1000);
      await deps.enqueue(QUEUE, ref, {
        startAfterSeconds: Math.min(MAX_RETRY_SECONDS, Math.max(MIN_RETRY_SECONDS, seconds)),
      });
      // Die Pause gilt für das Profil; der eingeplante Lauf holt auch die übrigen Übermittlungen ab.
      break;
    }

    await finishAdChangeSubmission(deps.db, { ...submissionRef, now: now() });
  }

  if (failure !== null) throw new JobFailure(failure, counters);
  return { counters };
}

function abortMessage(cause: unknown): string {
  if (cause instanceof AmazonAdsHttpError) {
    return `Amazon hat den Zugriff abgelehnt (HTTP ${cause.status}).`;
  }
  return 'Unerwarteter Fehler beim Senden. Details im Log.';
}

/** Ergebnis je Operation → Ergebnis je Änderung; `unsent` bleibt offen. */
function toChangeResults(
  results: readonly AmazonAdsWriteResult[],
  changeIdsByRef: ReadonlyMap<string, string[]>,
): AdChangeResultInput[] {
  const changes: AdChangeResultInput[] = [];
  for (const result of results) {
    if (result.status === 'unsent') continue;
    for (const changeId of changeIdsByRef.get(result.ref) ?? []) {
      if (result.status === 'applied') {
        changes.push({ changeId, outcome: 'applied', amazonEntityId: result.amazonId });
      } else if (result.status === 'failed') {
        changes.push({ changeId, outcome: 'failed', code: result.code, message: result.message });
      } else {
        changes.push({
          changeId,
          outcome: 'failed',
          code: AD_CHANGE_UNKNOWN_OUTCOME,
          message: `${result.message} ${UNKNOWN_HINT}`,
        });
      }
    }
  }
  return changes;
}

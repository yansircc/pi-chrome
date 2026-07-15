import * as Effect from "effect/Effect";
import { validateOperationSuccess } from "../protocol/operation-contract.js";
import type { ProfileConnector, WireCommand, WireResult } from "../protocol/schema.js";
import {
  BrowserOutcomeUnknown,
  BrowserRejected,
  makeBrowserFailureResult,
} from "./browser-command-failure.js";
import type { LoadedCommandJournalEntry } from "./command-journal.js";

export type BrowserCommandDispatch = (command: WireCommand) => Promise<unknown>;

export const settleBrowserCommand = (
  command: WireCommand,
  dispatch: BrowserCommandDispatch,
): Effect.Effect<WireResult> =>
  Effect.tryPromise({
    try: () => dispatch(command),
    catch: (cause) =>
      cause instanceof BrowserRejected || cause instanceof BrowserOutcomeUnknown
        ? cause
        : new BrowserRejected(cause instanceof Error ? cause.message : String(cause), { cause }),
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) => Effect.succeed(makeBrowserFailureResult(command.id, error)),
      onSuccess: (value) =>
        validateOperationSuccess(command, value).pipe(
          Effect.match({
            onFailure: (cause): WireResult =>
              makeBrowserFailureResult(
                command.id,
                new BrowserOutcomeUnknown(
                  `Browser operation ${command.domain} returned a value outside its result contract. ` +
                    "It may have changed Chrome and will not be repeated.",
                  { cause },
                ),
              ),
            onSuccess: (validated): WireResult => ({ id: command.id, ok: true, value: validated }),
          }),
        ),
    }),
  );

type RuntimeEffect<Value> = Effect.Effect<Value, unknown>;

export type ConnectorRuntimePort = {
  readonly loadConnector: RuntimeEffect<ProfileConnector>;
  readonly loadJournal: RuntimeEffect<LoadedCommandJournalEntry | undefined>;
  readonly deliverResult: (result: WireResult, connector: ProfileConnector) => RuntimeEffect<void>;
  readonly clearJournal: RuntimeEffect<void>;
  readonly receiveCommand: (connector: ProfileConnector) => RuntimeEffect<WireCommand | undefined>;
  readonly recordExecuting: (command: WireCommand) => RuntimeEffect<void>;
  readonly executeCommand: (command: WireCommand) => RuntimeEffect<WireResult>;
  readonly recordResult: (command: WireCommand, result: WireResult) => RuntimeEffect<void>;
};

// One step owns exactly one durable state transition. A delivered command cannot release this
// Effect until its non-cancellable Chrome Promise settles and its result is journaled. Therefore
// the sequential caller cannot poll another command while an earlier side effect is still live.
export const connectorRuntimeStep = (port: ConnectorRuntimePort): RuntimeEffect<void> =>
  Effect.gen(function* () {
    const connector = yield* port.loadConnector;
    const journal = yield* port.loadJournal;
    if (journal) {
      yield* port.deliverResult(journal.result, connector);
      yield* port.clearJournal;
      return;
    }

    const command = yield* port.receiveCommand(connector);
    if (!command) return;
    yield* port.recordExecuting(command);
    const result = yield* port.executeCommand(command);
    yield* port.recordResult(command, result);
  });

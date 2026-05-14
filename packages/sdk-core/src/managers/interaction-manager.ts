/**
 * Interaction manager for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/managers
 */

import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";
import type { ConferenceSession } from "../room";
import { StateContainer } from "../state/state-container";
import type { Reaction, ReactionEmoji } from "../types";
import { TypedEventEmitter } from "../utils/typed-emitter";

/** Interaction manager state */
export interface InteractionState {
  /** Whether local user has hand raised */
  readonly isHandRaised: boolean;
  /** Participant IDs with raised hands */
  readonly raisedHands: readonly string[];
  /** Active floating reactions (auto-dismiss) */
  readonly activeReactions: readonly ActiveReaction[];
}

/** Active reaction with expiration */
export interface ActiveReaction {
  id: string;
  participantId: string;
  participantName: string;
  emoji: string;
  timestamp: Date;
}

/** Interaction manager events */
export interface InteractionManagerEvents {
  /** Floating reaction sent */
  reaction: Reaction;
  /** Hand raised by participant */
  "hand:raised": { participantId: string };
  /** Hand lowered by participant */
  "hand:lowered": { participantId: string };
  /** Error occurred */
  error: ChalkError;
}

const REACTION_DISMISS_MS = 3000;

/**
 * Manages floating reactions and hand raise
 */
export class InteractionManager extends StateContainer<InteractionState> {
  private readonly events = new TypedEventEmitter<InteractionManagerEvents>();
  private room: ConferenceSession | null = null;
  private roomUnsubscribers: Array<() => void> = [];
  private reactionTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private activeReactions: ActiveReaction[] = [];
  private raisedHandsSet = new Set<string>();

  constructor(_debug = false) {
    super({
      isHandRaised: false,
      raisedHands: [],
      activeReactions: [],
    });
  }

  /** Subscribe to interaction events */
  on<K extends keyof InteractionManagerEvents>(event: K, handler: (data: InteractionManagerEvents[K]) => void): () => void {
    return this.events.on(event, handler);
  }

  /** Attach ConferenceSession instance */
  attachRoom(room: ConferenceSession): void {
    this.teardownRoomListeners();
    this.room = room;
    this.setupRoomListeners();
    this.syncFromRoom();
  }

  private teardownRoomListeners(): void {
    for (const unsubscribe of this.roomUnsubscribers) {
      try {
        unsubscribe();
      } catch {
        // best effort cleanup
      }
    }
    this.roomUnsubscribers = [];
  }

  private syncFromRoom(): void {
    if (!this.room) return;

    // Sync hand raised state for local participant
    const isHandRaised = this.room.localParticipant?.handRaised ?? false;
    this.setState({ isHandRaised });

    // Sync raised hands for all participants
    this.raisedHandsSet.clear();
    for (const [id, participant] of this.room.participants) {
      if (participant.handRaised) {
        this.raisedHandsSet.add(id);
      }
    }
    this.updateRaisedHandsState();
  }

  private setupRoomListeners(): void {
    if (!this.room) return;

    this.roomUnsubscribers.push(
      this.room.on("reaction", (reaction) => {
        this.addReaction(reaction);
        this.events.emit("reaction", reaction);
      }),
    );

    this.roomUnsubscribers.push(
      this.room.on("hand.raised", ({ participantId }) => {
        this.raisedHandsSet.add(participantId);
        this.updateRaisedHandsState();

        // Update local hand state if it's us
        if (participantId === this.room?.localParticipant?.id) {
          this.setState({ isHandRaised: true });
        }

        this.events.emit("hand:raised", { participantId });
      }),
    );

    this.roomUnsubscribers.push(
      this.room.on("hand.lowered", ({ participantId }) => {
        this.raisedHandsSet.delete(participantId);
        this.updateRaisedHandsState();

        // Update local hand state if it's us
        if (participantId === this.room?.localParticipant?.id) {
          this.setState({ isHandRaised: false });
        }

        this.events.emit("hand:lowered", { participantId });
      }),
    );

    this.roomUnsubscribers.push(
      this.room.on("participant.left", (participantId) => {
        this.raisedHandsSet.delete(participantId);
        this.updateRaisedHandsState();
      }),
    );
  }

  private updateRaisedHandsState(): void {
    this.setState({
      raisedHands: Array.from(this.raisedHandsSet),
    });
  }

  private addReaction(reaction: Reaction): void {
    const activeReaction: ActiveReaction = {
      id: `${reaction.participantId}-${Date.now()}`,
      participantId: reaction.participantId,
      participantName: reaction.participantName,
      emoji: reaction.emoji,
      timestamp: reaction.timestamp instanceof Date ? reaction.timestamp : new Date(reaction.timestamp),
    };

    this.activeReactions.push(activeReaction);
    this.setState({ activeReactions: [...this.activeReactions] });

    // Auto-dismiss after timeout
    const timeout = setTimeout(() => {
      this.removeReaction(activeReaction.id);
    }, REACTION_DISMISS_MS);

    this.reactionTimeouts.set(activeReaction.id, timeout);
  }

  private removeReaction(id: string): void {
    const timeout = this.reactionTimeouts.get(id);
    if (timeout) {
      clearTimeout(timeout);
      this.reactionTimeouts.delete(id);
    }

    this.activeReactions = this.activeReactions.filter((r) => r.id !== id);
    this.setState({ activeReactions: [...this.activeReactions] });
  }

  /** Send a floating reaction */
  sendReaction(emoji: ReactionEmoji): void {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    this.room.sendReaction(emoji);
  }

  /** Raise hand */
  raiseHand(): void {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    this.room.raiseHand();
    this.setState({ isHandRaised: true });

    const localId = this.room.localParticipant?.id;
    if (localId) {
      this.raisedHandsSet.add(localId);
      this.updateRaisedHandsState();
    }
  }

  /** Lower hand */
  lowerHand(): void {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    this.room.lowerHand();
    this.setState({ isHandRaised: false });

    const localId = this.room.localParticipant?.id;
    if (localId) {
      this.raisedHandsSet.delete(localId);
      this.updateRaisedHandsState();
    }
  }

  /** Toggle hand raised state */
  toggleHand(): void {
    if (this.getState().isHandRaised) {
      this.lowerHand();
    } else {
      this.raiseHand();
    }
  }

  /** Get number of raised hands */
  get raisedHandCount(): number {
    return this.raisedHandsSet.size;
  }

  /** Cleanup resources */
  dispose(): void {
    this.teardownRoomListeners();
    this.room = null;
    // Clear all reaction timeouts
    for (const timeout of this.reactionTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.reactionTimeouts.clear();
    this.activeReactions = [];
    this.raisedHandsSet.clear();
    this.events.removeAllListeners();
  }
}

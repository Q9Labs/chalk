import {
	Crown01Icon,
	Microphone01Icon,
	MicrophoneOff01Icon,
	Shield01Icon,
	UserRemove01Icon,
} from '../../../utils/icons';
import { VolumeSlider } from '../../atomic';
import { cn } from '../../../utils/cn';
import type { Participant, ParticipantListVariant } from './ParticipantList';

export interface ParticipantOptionsMenuProps {
	participant: Participant;
	variant: ParticipantListVariant;
	canManageParticipants: boolean;
	onClose: () => void;
	onMuteParticipant?: (id: string) => void;
	onRemoveParticipant?: (id: string) => void;
	onMakeHost?: (id: string) => void;
	onMakeCoHost?: (id: string) => void;
	participantVolumes?: ReadonlyMap<string, number>;
	onParticipantVolumeChange?: (id: string, volume: number) => void;
}

export function ParticipantOptionsMenu({
	participant,
	variant,
	canManageParticipants,
	onClose,
	onMuteParticipant,
	onRemoveParticipant,
	onMakeHost,
	onMakeCoHost,
	participantVolumes,
	onParticipantVolumeChange,
}: ParticipantOptionsMenuProps) {
	const hasVolumeControl =
		!participant.isLocal && !!participantVolumes && !!onParticipantVolumeChange;
	const hasManageActions =
		canManageParticipants &&
		(!!onMuteParticipant ||
			!!onRemoveParticipant ||
			(!!onMakeHost && participant.role !== 'host') ||
			(!!onMakeCoHost && participant.role === 'participant'));

	const volume = participantVolumes?.get(participant.id) ?? 100;
	const volumeMuted = volume === 0;

	const menuItemClassName = cn(
		'w-full text-left px-3 py-2 text-sm flex items-center gap-2',
		variant === 'sidebar'
			? 'text-popover-foreground hover:bg-muted/50'
			: 'text-chalk-text-primary hover:bg-chalk-bg-subtle',
	);

	const dividerClassName = cn(
		'my-1 h-px',
		variant === 'sidebar' ? 'bg-border/50' : 'bg-chalk-border-subtle',
	);

	return (
		<>
			{hasVolumeControl && (
				<div
					className={cn(
						'px-3 py-2',
						variant === 'sidebar' ? 'text-popover-foreground' : 'text-chalk-text-primary',
					)}
				>
					<div className="flex items-center justify-between gap-3 mb-2">
						<span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground font-semibold">
							Volume
						</span>
						<button
							type="button"
							onClick={() => {
								onParticipantVolumeChange(participant.id, 100);
							}}
							className={cn(
								'text-xs underline underline-offset-2',
								variant === 'sidebar'
									? 'text-muted-foreground hover:text-foreground'
									: 'text-chalk-text-muted hover:text-chalk-text-primary',
							)}
							aria-label={`Reset volume for ${participant.displayName}`}
						>
							Reset
						</button>
					</div>
					<VolumeSlider
						value={volume}
						muted={volumeMuted}
						onChange={(vol) => onParticipantVolumeChange(participant.id, vol)}
						onMuteToggle={() =>
							onParticipantVolumeChange(participant.id, volumeMuted ? 100 : 0)
						}
						size={variant === 'mobile' ? 'md' : 'sm'}
						className="w-48"
						showValue
					/>
				</div>
			)}

			{hasVolumeControl && hasManageActions && <div className={dividerClassName} />}

			{hasManageActions && (
				<>
					{onMuteParticipant && (
						<button
							onClick={() => {
								onMuteParticipant(participant.id);
								onClose();
							}}
							className={menuItemClassName}
						>
							{participant.isMuted ? (
								<Microphone01Icon className="w-4 h-4" />
							) : (
								<MicrophoneOff01Icon className="w-4 h-4" />
							)}
							{participant.isMuted ? 'Unmute' : 'Mute'}
						</button>
					)}

					{onMakeHost && participant.role !== 'host' && (
						<button
							onClick={() => {
								onMakeHost(participant.id);
								onClose();
							}}
							className={menuItemClassName}
						>
							<Crown01Icon className="w-4 h-4" />
							Make Host
						</button>
					)}

					{onMakeCoHost && participant.role === 'participant' && (
						<button
							onClick={() => {
								onMakeCoHost(participant.id);
								onClose();
							}}
							className={menuItemClassName}
						>
							<Shield01Icon className="w-4 h-4" />
							Make Co-Host
						</button>
					)}

					{onRemoveParticipant && (
						<button
							onClick={() => {
								onRemoveParticipant(participant.id);
								onClose();
							}}
							className={cn(
								'w-full text-left px-3 py-2 text-sm flex items-center gap-2',
								variant === 'sidebar'
									? 'text-[#dc2626] hover:bg-[#dc2626]/10'
									: 'text-chalk-error-main hover:bg-chalk-error-subtle',
							)}
						>
							<UserRemove01Icon className="w-4 h-4" />
							Remove
						</button>
					)}
				</>
			)}
		</>
	);
}

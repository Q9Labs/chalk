import {
	MoreVerticalIcon,
	MicrophoneOff01Icon,
} from '../../../utils/icons';
import { Avatar, AudioIndicator, HandRaiseIndicator, IconButton } from '../../atomic';
import { cn } from '../../../utils/cn';
import type { Participant, ParticipantListVariant } from './ParticipantList';
import { ParticipantOptionsMenu } from './ParticipantOptionsMenu';

export interface ParticipantRowProps {
	participant: Participant;
	variant: ParticipantListVariant;
	canManageParticipants: boolean;
	onMuteParticipant?: (id: string) => void;
	onRemoveParticipant?: (id: string) => void;
	onMakeHost?: (id: string) => void;
	onMakeCoHost?: (id: string) => void;
	participantVolumes?: ReadonlyMap<string, number>;
	onParticipantVolumeChange?: (id: string, volume: number) => void;
	menuOpen: boolean;
	onMenuToggle: () => void;
	onMenuClose: () => void;
}

export function ParticipantRow({
	participant,
	variant,
	canManageParticipants,
	onMuteParticipant,
	onRemoveParticipant,
	onMakeHost,
	onMakeCoHost,
	participantVolumes,
	onParticipantVolumeChange,
	menuOpen,
	onMenuToggle,
	onMenuClose,
}: ParticipantRowProps) {
	const hasVolumeControl = !!participantVolumes && !!onParticipantVolumeChange;
	const showMenuButton = !participant.isLocal && (canManageParticipants || hasVolumeControl);

	const optionsButtonClassName =
		variant === 'mobile'
			? 'text-muted-foreground hover:text-foreground'
			: variant === 'sidebar'
				? 'opacity-70 hover:opacity-100 text-muted-foreground hover:text-foreground'
				: 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100';

	return (
		<div
			className={cn(
				'group flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors relative',
				variant === 'sidebar' && 'hover:bg-muted/50',
			)}
		>
			<div className="flex items-center gap-3 min-w-0">
				<div className="relative">
					<Avatar
						name={participant.displayName}
						size="sm"
						className={cn(variant === 'sidebar' && 'w-9 h-9')}
					/>
					{participant.isHandRaised && (
						<HandRaiseIndicator
							raised={true}
							size="sm"
							className="-top-1 -right-1"
						/>
					)}
				</div>

				<div className="flex flex-col min-w-0">
					<div className="flex items-center gap-1.5">
						<span
							className={cn(
								'text-sm font-normal truncate',
								variant === 'sidebar' ? 'text-card-foreground' : 'text-chalk-text-primary',
							)}
						>
							{participant.displayName}
						</span>
						{participant.isLocal && (
							<span
								className={cn(
									'text-xs',
									variant === 'sidebar' ? 'text-muted-foreground' : 'text-chalk-text-muted',
								)}
							>
								(you)
							</span>
						)}
					</div>
					<div className="flex items-center gap-1.5">
						{participant.role && participant.role !== 'participant' && (
							<span
								className={cn(
									'text-[11px] tracking-normal font-normal',
									variant === 'sidebar'
										? 'text-muted-foreground'
										: 'text-chalk-text-secondary bg-chalk-bg-subtle px-1.5 py-0.5 rounded',
								)}
							>
								{variant === 'sidebar' && participant.role === 'host'
									? 'Meeting Host'
									: participant.role}
							</span>
						)}
					</div>
				</div>
			</div>

			<div className="flex items-center gap-1">
				{variant === 'sidebar' ? (
					participant.isMuted ? (
						<div className="bg-[#dc2626]/20 p-1.5 rounded-full">
							<MicrophoneOff01Icon className="w-3.5 h-3.5 text-[#dc2626]" />
						</div>
					) : null
				) : (
					<AudioIndicator
						muted={participant.isMuted}
						level={participant.isMuted ? 0 : 0.5}
						className={cn(participant.isMuted && 'text-chalk-error-main')}
					/>
				)}

				{showMenuButton && (
					<div className="relative">
						<IconButton
							icon={<MoreVerticalIcon className="w-4 h-4" />}
							size="sm"
							variant="ghost"
							className={optionsButtonClassName}
							onClick={onMenuToggle}
							aria-label={`Options for ${participant.displayName}`}
						/>

						{menuOpen && (
							<>
								<div className="fixed inset-0 z-10" onClick={onMenuClose} />
								<div
									className={cn(
										'absolute right-0 top-full mt-1 w-64 rounded-lg shadow-xl z-20 overflow-hidden py-1',
										variant === 'sidebar'
											? 'bg-popover/95 backdrop-blur-xl border border-border/50'
											: 'bg-chalk-bg-surface border border-chalk-border-subtle',
									)}
								>
									<ParticipantOptionsMenu
										participant={participant}
										variant={variant}
										canManageParticipants={canManageParticipants}
										onClose={onMenuClose}
										onMuteParticipant={onMuteParticipant}
										onRemoveParticipant={onRemoveParticipant}
										onMakeHost={onMakeHost}
										onMakeCoHost={onMakeCoHost}
										participantVolumes={participantVolumes}
										onParticipantVolumeChange={onParticipantVolumeChange}
									/>
								</div>
							</>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

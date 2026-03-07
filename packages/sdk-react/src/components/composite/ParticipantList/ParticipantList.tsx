import React, { useMemo, useState } from 'react';
import { Cancel01Icon, Search01Icon, UserGroupIcon } from '../../../utils/icons';
import { Badge, IconButton, Input } from '../../atomic';
import { Button } from '../../ui';
import { usePrefersReducedMotion } from '../../../hooks/useMediaQuery';
import { cn } from '../../../utils/cn';
import { getParticipantThemeVariables } from '../../../utils/colorGenerator';
import { ParticipantRow } from './ParticipantRow';

export interface Participant {
	id: string;
	displayName: string;
	isLocal?: boolean;
	isMuted?: boolean;
	isVideoEnabled?: boolean;
	isHandRaised?: boolean;
	role?: 'host' | 'co-host' | 'participant';
	avatarUrl?: string;
}

export type ParticipantListVariant = 'default' | 'sidebar' | 'mobile';

export interface ParticipantListProps {
	participants: Participant[];
	onMuteParticipant?: (id: string) => void;
	onRemoveParticipant?: (id: string) => void;
	onMakeHost?: (id: string) => void;
	onMakeCoHost?: (id: string) => void;
	onAddPeople?: () => void;
	canManageParticipants?: boolean;
	searchable?: boolean;
	onClose?: () => void;
	/** Per-participant volume overrides (0-100). Only contains adjusted participants. */
	participantVolumes?: ReadonlyMap<string, number>;
	/** Called when a participant's volume is changed via the slider. */
	onParticipantVolumeChange?: (id: string, volume: number) => void;
	participantColorSeed?: string;
	className?: string;
	variant?: ParticipantListVariant;
	title?: string;
}

export const ParticipantList = React.memo(({
	participants,
	onMuteParticipant,
	onRemoveParticipant,
	onMakeHost,
	onMakeCoHost,
	onAddPeople,
	participantVolumes,
	onParticipantVolumeChange,
	participantColorSeed,
	canManageParticipants = false,
	searchable = true,
	onClose,
	className,
	variant = 'default',
	title = 'Participants',
}: ParticipantListProps) => {
	const prefersReducedMotion = usePrefersReducedMotion();
	const [searchQuery, setSearchQuery] = useState('');
	const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
	const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed), [participantColorSeed]);

	const filteredParticipants = useMemo(() => {
		let sorted = [...participants].sort((a, b) => {
			const aScore = a.role === 'host' ? 2 : a.role === 'co-host' ? 1 : 0;
			const bScore = b.role === 'host' ? 2 : b.role === 'co-host' ? 1 : 0;

			if (aScore !== bScore) return bScore - aScore;

			if (a.isLocal) return -1;
			if (b.isLocal) return 1;

			return a.displayName.localeCompare(b.displayName);
		});

		if (searchQuery) {
			sorted = sorted.filter((p) =>
				p.displayName.toLowerCase().includes(searchQuery.toLowerCase()),
			);
		}

		return sorted;
	}, [participants, searchQuery]);

	const listSpacingClassName = variant === 'sidebar' ? 'space-y-0.5' : 'space-y-1';
	const emptyTextClassName =
		variant === 'default' ? 'text-chalk-text-muted' : 'text-muted-foreground';

	const rows = (
		<div className={listSpacingClassName}>
			{filteredParticipants.length === 0 ? (
				<div className={cn('p-8 text-center text-sm', emptyTextClassName)}>
					No participants found
				</div>
			) : (
				filteredParticipants.map((participant) => (
					<ParticipantRow
						key={participant.id}
						participant={participant}
						variant={variant}
						canManageParticipants={canManageParticipants}
						onMuteParticipant={onMuteParticipant}
						onRemoveParticipant={onRemoveParticipant}
						onMakeHost={onMakeHost}
						onMakeCoHost={onMakeCoHost}
						participantVolumes={participantVolumes}
						onParticipantVolumeChange={onParticipantVolumeChange}
						menuOpen={activeMenuId === participant.id}
						onMenuToggle={() =>
							setActiveMenuId((prev) => (prev === participant.id ? null : participant.id))
						}
						onMenuClose={() => setActiveMenuId(null)}
					/>
				))
			)}
		</div>
	);

	// Mobile variant - fills container, no header (MobilePanel provides it)
	if (variant === 'mobile') {
		return (
			<div
				className={cn(
					'flex flex-col h-full w-full overflow-hidden font-sans relative bg-card',
					className,
				)}
				style={themeVariables as React.CSSProperties}
				data-tour="participants-panel"
				role="complementary"
				aria-label="Participants list"
			>
				<div className="flex-1 overflow-y-auto px-4 py-4">
					{onAddPeople && (
						<Button
							onClick={onAddPeople}
							className="w-full bg-primary hover:bg-primary/90 text-primary-foreground rounded-full py-3 px-4 mb-4 shadow-lg shadow-primary/25 min-h-[48px]"
						>
							<UserGroupIcon className="w-4 h-4" />
							<span>Add people</span>
						</Button>
					)}

					{/* Section Label */}
					<div className="mb-3 px-1">
						<p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground font-semibold">
							IN THE MEETING ({participants.length})
						</p>
					</div>

					{/* Participants List */}
					{rows}
				</div>
			</div>
		);
	}

	if (variant === 'sidebar') {
		return (
			<div
				className={cn(
					'flex flex-col h-full w-full overflow-hidden font-sans relative bg-transparent',
					!prefersReducedMotion && 'chalk-animate-slide-right',
					className,
				)}
				style={themeVariables as React.CSSProperties}
				data-tour="participants-panel"
				role="complementary"
				aria-label="Participants list"
			>
				{/* Header */}
				<div className="flex items-center justify-between px-6 py-5">
					<div className="flex items-center gap-2">
						<h2 className="text-lg font-semibold text-card-foreground tracking-tight">
							{title === 'Participants' ? 'People' : title}
						</h2>
						<span className="text-muted-foreground text-sm font-medium">
							({participants.length})
						</span>
					</div>

					<div className="flex items-center gap-2">
						{onAddPeople && (
							<Button
								onClick={onAddPeople}
								className="h-8 px-3 text-sm font-medium bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary border-0 gap-1.5 rounded-md transition-colors"
							>
								<UserGroupIcon className="w-4 h-4" />
								<span>Add</span>
							</Button>
						)}
						{onClose && (
							<button
								onClick={onClose}
								className="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-md hover:bg-muted/50"
								aria-label="Close"
							>
								<Cancel01Icon className="w-5 h-5" />
							</button>
						)}
					</div>
				</div>

				{searchable && (
					<div className="px-6 pb-2">
						<Input
							placeholder="Search for people..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							icon={<Search01Icon className="w-4 h-4 text-muted-foreground" />}
							iconPosition="left"
							className="w-full bg-muted/30 border-transparent focus:bg-background focus:border-primary/20 transition-all placeholder:text-muted-foreground/70"
						/>
					</div>
				)}

				<div className="flex-1 overflow-y-auto px-4 pb-6 mt-2">
					{/* Section Label */}
					<div className="mb-2 px-3">
						<p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground font-semibold">
							In Meeting
						</p>
					</div>

					{/* Participants List */}
					{rows}
				</div>
			</div>
		);
	}

	// Default rendering (preserving exact existing structure/classes)
	return (
		<div
			className={cn(
				'flex flex-col h-full bg-chalk-bg-surface border-l border-chalk-border-subtle w-80 shadow-xl',
				!prefersReducedMotion && 'chalk-animate-slide-right',
				className,
			)}
			style={themeVariables as React.CSSProperties}
			data-tour="participants-panel"
			role="complementary"
			aria-label="Participants list"
		>
			<div className="flex items-center justify-between p-4 border-b border-chalk-border-subtle">
				<div className="flex items-center gap-2">
					<h2 className="text-sm font-semibold text-chalk-text-primary">{title}</h2>
					<Badge variant="default" count={participants.length} />
				</div>
				{onClose && (
					<IconButton
						icon={<Cancel01Icon className="w-4 h-4" />}
						size="sm"
						variant="ghost"
						onClick={onClose}
						aria-label="Close participant list"
					/>
				)}
			</div>

			{searchable && (
				<div className="p-4 pb-2">
					<Input
						placeholder="Search participants..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						icon={<Search01Icon className="w-4 h-4" />}
						iconPosition="left"
						className="w-full"
					/>
				</div>
			)}

			<div className="flex-1 overflow-y-auto p-2">{rows}</div>
		</div>
	);
});

ParticipantList.displayName = 'ParticipantList';

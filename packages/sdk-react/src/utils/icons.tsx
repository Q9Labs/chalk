import {
	Alert02Icon as Alert02IconSvg,
	ArrowDown01Icon as ArrowDown01IconSvg,
	ArrowLeft01Icon as ArrowLeft01IconSvg,
	ArrowLeft02Icon as ArrowLeft02IconSvg,
	ArrowRight01Icon as ArrowRight01IconSvg,
	ArrowUp01Icon as ArrowUp01IconSvg,
	Calendar01Icon as Calendar01IconSvg,
	CallEnd01Icon as CallEnd01IconSvg,
	Cancel01Icon as Cancel01IconSvg,
	CancelCircleIcon as CancelCircleIconSvg,
	CheckmarkCircle02Icon as CheckmarkCircle02IconSvg,
	CircleIcon as CircleIconSvg,
	Clock01Icon as Clock01IconSvg,
	Copy01Icon as Copy01IconSvg,
	CrownIcon as Crown01IconSvg,
	Download01Icon as Download01IconSvg,
	Edit02Icon as Edit02IconSvg,
	FileIcon as FileTextIconSvg,
	GridIcon as GridIconSvg,
	WavingHand01Icon as HandIconSvg,
	Home01Icon as Home01IconSvg,
	Image01Icon as Image01IconSvg,
	InformationCircleIcon as InformationCircleIconSvg,
	LayoutTwoColumnIcon as LayoutTwoColumnIconSvg,
	LayoutGridIcon as LayoutGridIconSvg,
	LayoutTableIcon as LayoutTableIconSvg,
	Link01Icon as Link01IconSvg,
	Loading01Icon as Loading01IconSvg,
	Mail01Icon as Mail01IconSvg,
	MaximizeScreenIcon as Maximize01IconSvg,
	Message01Icon as Message01IconSvg,
	Mic01Icon as Microphone01IconSvg,
	MicOff01Icon as MicrophoneOff01IconSvg,
	Moon02Icon as Moon02IconSvg,
	ComputerVideoIcon as Monitor01IconSvg,
	ComputerRemoveIcon as MonitorOffIconSvg,
	MoreHorizontalIcon as MoreHorizontalIconSvg,
	MoreVerticalIcon as MoreVerticalIconSvg,
	PauseIcon as PauseIconSvg,
	PinIcon as Pin01IconSvg,
	PlayIcon as PlayIconSvg,
	PlusSignIcon as PlusSignIconSvg,
	Radio01Icon as Radio01IconSvg,
	RefreshIcon as RefreshIconSvg,
	Search01Icon as Search01IconSvg,
	SentIcon as SentIconSvg,
	Settings01Icon as Settings01IconSvg,
	Share01Icon as Share01IconSvg,
	Shield01Icon as Shield01IconSvg,
	SmileIcon as SmileIconSvg,
	SparklesIcon as SparklesIconSvg,
	SquareIcon as SquareIconSvg,
	StarIcon as StarIconSvg,
	Sun02Icon as Sun02IconSvg,
	TextIcon as TextIconSvg,
	ThumbsUpIcon as ThumbsUpIconSvg,
	Tick01Icon as Tick01IconSvg,
	TickDouble01Icon as TickDouble01IconSvg,
	Upload01Icon as Upload01IconSvg,
	UserGroupIcon as UserGroupIconSvg,
	UserRemove01Icon as UserRemove01IconSvg,
	Video01Icon as Video01IconSvg,
	VideoOffIcon as VideoOffIconSvg,
	VolumeHighIcon as VolumeHighIconSvg,
	VolumeMute01Icon as VolumeMute01IconSvg,
	WifiOffIcon as WifiOffIconSvg,
	ZoomInAreaIcon as ZoomInIconSvg,
	ZoomOutAreaIcon as ZoomOutIconSvg,
} from "@hugeicons/core-free-icons";
import type { HugeiconsProps, IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";

type IconProps = Omit<HugeiconsProps, "icon">;

const createIcon = (iconSvg: IconSvgElement) => {
	const Icon = (props: IconProps) => (
		<HugeiconsIcon icon={iconSvg} {...props} />
	);
	return Icon;
};

export const Alert02Icon = createIcon(Alert02IconSvg);
export const ArrowDown01Icon = createIcon(ArrowDown01IconSvg);
export const ArrowLeft01Icon = createIcon(ArrowLeft01IconSvg);
export const ArrowLeft02Icon = createIcon(ArrowLeft02IconSvg);
export const ArrowRight01Icon = createIcon(ArrowRight01IconSvg);
export const ArrowUp01Icon = createIcon(ArrowUp01IconSvg);
export const Calendar01Icon = createIcon(Calendar01IconSvg);
export const CallEnd01Icon = createIcon(CallEnd01IconSvg);
export const Cancel01Icon = createIcon(Cancel01IconSvg);
export const CancelCircleIcon = createIcon(CancelCircleIconSvg);
export const CheckmarkCircle02Icon = createIcon(CheckmarkCircle02IconSvg);
export const CircleIcon = createIcon(CircleIconSvg);
export const Clock01Icon = createIcon(Clock01IconSvg);
export const ColumnIcon = createIcon(LayoutTwoColumnIconSvg);
export const Copy01Icon = createIcon(Copy01IconSvg);
export const Crown01Icon = createIcon(Crown01IconSvg);
export const Download01Icon = createIcon(Download01IconSvg);
export const Edit02Icon = createIcon(Edit02IconSvg);
export const FileTextIcon = createIcon(FileTextIconSvg);
export const GridIcon = createIcon(GridIconSvg);
export const HandIcon = createIcon(HandIconSvg);
export const Home01Icon = createIcon(Home01IconSvg);
export const Image01Icon = createIcon(Image01IconSvg);
export const InformationCircleIcon = createIcon(InformationCircleIconSvg);
export const LayoutGridIcon = createIcon(LayoutGridIconSvg);
export const LayoutTableIcon = createIcon(LayoutTableIconSvg);
export const Link01Icon = createIcon(Link01IconSvg);
export const Loading01Icon = createIcon(Loading01IconSvg);
export const Mail01Icon = createIcon(Mail01IconSvg);
export const Maximize01Icon = createIcon(Maximize01IconSvg);
export const Message01Icon = createIcon(Message01IconSvg);
export const Microphone01Icon = createIcon(Microphone01IconSvg);
export const MicrophoneOff01Icon = createIcon(MicrophoneOff01IconSvg);
export const Moon02Icon = createIcon(Moon02IconSvg);
export const Monitor01Icon = createIcon(Monitor01IconSvg);
export const MonitorOffIcon = createIcon(MonitorOffIconSvg);
export const MoreHorizontalIcon = createIcon(MoreHorizontalIconSvg);
export const MoreVerticalIcon = createIcon(MoreVerticalIconSvg);
export const PauseIcon = createIcon(PauseIconSvg);
export const Pin01Icon = createIcon(Pin01IconSvg);
export const PlayIcon = createIcon(PlayIconSvg);
export const PlusSignIcon = createIcon(PlusSignIconSvg);
export const Radio01Icon = createIcon(Radio01IconSvg);
export const RefreshIcon = createIcon(RefreshIconSvg);
export const Search01Icon = createIcon(Search01IconSvg);
export const SentIcon = createIcon(SentIconSvg);
export const Settings01Icon = createIcon(Settings01IconSvg);
export const Share01Icon = createIcon(Share01IconSvg);
export const Shield01Icon = createIcon(Shield01IconSvg);
export const SmileIcon = createIcon(SmileIconSvg);
export const SparklesIcon = createIcon(SparklesIconSvg);
export const SquareIcon = createIcon(SquareIconSvg);
export const StarIcon = createIcon(StarIconSvg);
export const Sun02Icon = createIcon(Sun02IconSvg);
export const TextIcon = createIcon(TextIconSvg);
export const ThumbsUpIcon = createIcon(ThumbsUpIconSvg);
export const Tick01Icon = createIcon(Tick01IconSvg);
export const TickDouble01Icon = createIcon(TickDouble01IconSvg);
export const Upload01Icon = createIcon(Upload01IconSvg);
export const UserGroupIcon = createIcon(UserGroupIconSvg);
export const UserRemove01Icon = createIcon(UserRemove01IconSvg);
export const Video01Icon = createIcon(Video01IconSvg);
export const VideoOffIcon = createIcon(VideoOffIconSvg);
export const VolumeHighIcon = createIcon(VolumeHighIconSvg);
export const VolumeMute01Icon = createIcon(VolumeMute01IconSvg);
export const WifiOffIcon = createIcon(WifiOffIconSvg);
export const ZoomInIcon = createIcon(ZoomInIconSvg);
export const ZoomOutIcon = createIcon(ZoomOutIconSvg);

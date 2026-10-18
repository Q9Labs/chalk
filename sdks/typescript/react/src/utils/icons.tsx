import {
  Alert02Icon as Alert02IconSvg,
  ArrowDown01Icon as ArrowDown01IconSvg,
  ArrowLeft01Icon as ArrowLeft01IconSvg,
  ArrowRight01Icon as ArrowRight01IconSvg,
  CallEnd01Icon as CallEnd01IconSvg,
  CancelCircleIcon as CancelCircleIconSvg,
  CheckmarkCircle02Icon as CheckmarkCircle02IconSvg,
  CircleIcon as CircleIconSvg,
  FileIcon as FileTextIconSvg,
  GridIcon as GridIconSvg,
  WavingHand01Icon as HandIconSvg,
  LayoutTwoColumnIcon as LayoutTwoColumnIconSvg,
  LayoutGridIcon as LayoutGridIconSvg,
  LayoutTableIcon as LayoutTableIconSvg,
  Loading01Icon as Loading01IconSvg,
  MicOff01Icon as MicrophoneOff01IconSvg,
  ComputerVideoIcon as Monitor01IconSvg,
  ComputerRemoveIcon as MonitorOffIconSvg,
  Radio01Icon as Radio01IconSvg,
  SignalFull02Icon as SignalFull02IconSvg,
  SquareIcon as SquareIconSvg,
  Sun02Icon as Sun02IconSvg,
  TextIcon as TextIconSvg,
  Tick01Icon as Tick01IconSvg,
  TickDouble01Icon as TickDouble01IconSvg,
  VideoOffIcon as VideoOffIconSvg,
  WifiOffIcon as WifiOffIconSvg,
} from "@hugeicons/core-free-icons";
import type { HugeiconsProps, IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon as StaticCancel01Icon,
  Clock01Icon as StaticClock01Icon,
  Copy01Icon as StaticCopy01Icon,
  CrownIcon as StaticCrown01Icon,
  Download01Icon as StaticDownload01Icon,
  Edit02Icon as StaticEdit02Icon,
  Home01Icon as StaticHome01Icon,
  Logout01Icon as StaticLogout01Icon,
  Image01Icon as StaticImage01Icon,
  InformationCircleIcon as StaticInformationCircleIcon,
  Link01Icon as StaticLink01Icon,
  MaximizeScreenIcon as StaticMaximize01Icon,
  Message01Icon as StaticMessage01Icon,
  Mic01Icon as StaticMicrophone01Icon,
  Moon02Icon as StaticMoon02Icon,
  MoreHorizontalIcon as StaticMoreHorizontalIcon,
  MoreVerticalIcon as StaticMoreVerticalIcon,
  PauseIcon as StaticPauseIcon,
  PinIcon as StaticPin01Icon,
  PlayIcon as StaticPlayIcon,
  PlusSignIcon as StaticPlusSignIcon,
  QrCode01Icon as StaticQrCode01Icon,
  RefreshIcon as StaticRefreshIcon,
  Search01Icon as StaticSearch01Icon,
  SentIcon as StaticSentIcon,
  Settings01Icon as StaticSettings01Icon,
  Share08Icon as StaticShare01Icon,
  Shield02Icon as StaticShield01Icon,
  SmileIcon as StaticSmileIcon,
  SparklesIcon as StaticSparklesIcon,
  StarIcon as StaticStarIcon,
  ThumbsUpIcon as StaticThumbsUpIcon,
  Upload01Icon as StaticUpload01Icon,
  UserAdd01Icon as StaticUserAdd01Icon,
  UserGroupIcon as StaticUserGroupIcon,
  UserRemove01Icon as StaticUserRemove01Icon,
  Video01Icon as StaticVideo01Icon,
  VolumeHighIcon as StaticVolumeHighIcon,
  VolumeMute01Icon as StaticVolumeMute01Icon,
} from "@hugeicons/core-free-icons";

type IconProps = Omit<HugeiconsProps, "icon">;

const createIcon = (iconSvg: IconSvgElement) => {
  const Icon = (props: IconProps) => <HugeiconsIcon icon={iconSvg} {...props} />;
  return Icon;
};

export const Alert02Icon = createIcon(Alert02IconSvg);
export const ArrowDown01Icon = createIcon(ArrowDown01IconSvg);
export const ArrowLeft01Icon = createIcon(ArrowLeft01IconSvg);
export const ArrowRight01Icon = createIcon(ArrowRight01IconSvg);
export const CallEnd01Icon = createIcon(CallEnd01IconSvg);
export const Cancel01Icon = createIcon(StaticCancel01Icon);
export const CancelCircleIcon = createIcon(CancelCircleIconSvg);
export const CheckmarkCircle02Icon = createIcon(CheckmarkCircle02IconSvg);
export const CircleIcon = createIcon(CircleIconSvg);
export const Clock01Icon = createIcon(StaticClock01Icon);
export const ColumnIcon = createIcon(LayoutTwoColumnIconSvg);
export const Copy01Icon = createIcon(StaticCopy01Icon);
export const Crown01Icon = createIcon(StaticCrown01Icon);
export const Download01Icon = createIcon(StaticDownload01Icon);
export const Edit02Icon = createIcon(StaticEdit02Icon);
export const FileTextIcon = createIcon(FileTextIconSvg);
export const GridIcon = createIcon(GridIconSvg);
export const HandIcon = createIcon(HandIconSvg);
export const Home01Icon = createIcon(StaticHome01Icon);
export const Logout01Icon = createIcon(StaticLogout01Icon);
export const Image01Icon = createIcon(StaticImage01Icon);
export const InformationCircleIcon = createIcon(StaticInformationCircleIcon);
export const LayoutGridIcon = createIcon(LayoutGridIconSvg);
export const LayoutTableIcon = createIcon(LayoutTableIconSvg);
export const Link01Icon = createIcon(StaticLink01Icon);
export const Loading01Icon = createIcon(Loading01IconSvg);
export const Maximize01Icon = createIcon(StaticMaximize01Icon);
export const Message01Icon = createIcon(StaticMessage01Icon);
export const Microphone01Icon = createIcon(StaticMicrophone01Icon);
export const MicrophoneOff01Icon = createIcon(MicrophoneOff01IconSvg);
export const Moon02Icon = createIcon(StaticMoon02Icon);
export const Monitor01Icon = createIcon(Monitor01IconSvg);
export const MonitorOffIcon = createIcon(MonitorOffIconSvg);
export const MoreHorizontalIcon = createIcon(StaticMoreHorizontalIcon);
export const MoreVerticalIcon = createIcon(StaticMoreVerticalIcon);
export const PauseIcon = createIcon(StaticPauseIcon);
export const Pin01Icon = createIcon(StaticPin01Icon);
export const PlayIcon = createIcon(StaticPlayIcon);
export const PlusSignIcon = createIcon(StaticPlusSignIcon);
export const QrCode01Icon = createIcon(StaticQrCode01Icon);
export const Radio01Icon = createIcon(Radio01IconSvg);
export const RefreshIcon = createIcon(StaticRefreshIcon);
export const Search01Icon = createIcon(StaticSearch01Icon);
export const SentIcon = createIcon(StaticSentIcon);
export const Settings01Icon = createIcon(StaticSettings01Icon);
export const Share01Icon = createIcon(StaticShare01Icon);
export const Shield01Icon = createIcon(StaticShield01Icon);
export const SignalFull02Icon = createIcon(SignalFull02IconSvg);
export const SmileIcon = createIcon(StaticSmileIcon);
export const SparklesIcon = createIcon(StaticSparklesIcon);
export const SquareIcon = createIcon(SquareIconSvg);
export const StarIcon = createIcon(StaticStarIcon);
export const Sun02Icon = createIcon(Sun02IconSvg);
export const TextIcon = createIcon(TextIconSvg);
export const Tick01Icon = createIcon(Tick01IconSvg);
export const TickDouble01Icon = createIcon(TickDouble01IconSvg);
export const Upload01Icon = createIcon(StaticUpload01Icon);
export const UserAdd01Icon = createIcon(StaticUserAdd01Icon);
export const UserGroupIcon = createIcon(StaticUserGroupIcon);
export const UserRemove01Icon = createIcon(StaticUserRemove01Icon);
export const Video01Icon = createIcon(StaticVideo01Icon);
export const VideoOffIcon = createIcon(VideoOffIconSvg);
export const VolumeHighIcon = createIcon(StaticVolumeHighIcon);
export const VolumeMute01Icon = createIcon(StaticVolumeMute01Icon);
export const WifiOffIcon = createIcon(WifiOffIconSvg);

export const ThumbsUpIcon = createIcon(StaticThumbsUpIcon);

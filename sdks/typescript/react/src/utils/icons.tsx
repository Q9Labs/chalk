import {
  Alert02Icon as Alert02IconSvg,
  ArrowDown01Icon as ArrowDown01IconSvg,
  ArrowLeft01Icon as ArrowLeft01IconSvg,
  ArrowRight01Icon as ArrowRight01IconSvg,
  ArrowUp01Icon as ArrowUp01IconSvg,
  Calendar01Icon as Calendar01IconSvg,
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
  ArrowLeft02Icon as AnimatedArrowLeft02Icon,
  Cancel01Icon as AnimatedCancel01Icon,
  Clock01Icon as AnimatedClock01Icon,
  Copy01Icon as AnimatedCopy01Icon,
  CrownIcon as AnimatedCrown01Icon,
  Download01Icon as AnimatedDownload01Icon,
  Edit02Icon as AnimatedEdit02Icon,
  Home01Icon as AnimatedHome01Icon,
  Image01Icon as AnimatedImage01Icon,
  InformationCircleIcon as AnimatedInformationCircleIcon,
  Link01Icon as AnimatedLink01Icon,
  Mail01Icon as AnimatedMail01Icon,
  MaximizeScreenIcon as AnimatedMaximize01Icon,
  Message01Icon as AnimatedMessage01Icon,
  Mic01Icon as AnimatedMicrophone01Icon,
  Moon02Icon as AnimatedMoon02Icon,
  MoreHorizontalIcon as AnimatedMoreHorizontalIcon,
  MoreVerticalIcon as AnimatedMoreVerticalIcon,
  PauseIcon as AnimatedPauseIcon,
  PinIcon as AnimatedPin01Icon,
  PlayIcon as AnimatedPlayIcon,
  PlusSignIcon as AnimatedPlusSignIcon,
  QrCode01Icon as AnimatedQrCode01Icon,
  RefreshIcon as AnimatedRefreshIcon,
  Search01Icon as AnimatedSearch01Icon,
  SentIcon as AnimatedSentIcon,
  Settings01Icon as AnimatedSettings01Icon,
  Share08Icon as AnimatedShare01Icon,
  Shield02Icon as AnimatedShield01Icon,
  SmileIcon as AnimatedSmileIcon,
  SparklesIcon as AnimatedSparklesIcon,
  StarIcon as AnimatedStarIcon,
  ThumbsUpIcon as AnimatedThumbsUpIcon,
  Upload01Icon as AnimatedUpload01Icon,
  UserAdd01Icon as AnimatedUserAdd01Icon,
  UserGroupIcon as AnimatedUserGroupIcon,
  UserRemove01Icon as AnimatedUserRemove01Icon,
  Video01Icon as AnimatedVideo01Icon,
  VolumeHighIcon as AnimatedVolumeHighIcon,
  VolumeMute01Icon as AnimatedVolumeMute01Icon,
  ZoomInAreaIcon as AnimatedZoomInIcon,
  ZoomOutAreaIcon as AnimatedZoomOutIcon,
} from "./animated-icons";

type IconProps = Omit<HugeiconsProps, "icon">;

const createIcon = (iconSvg: IconSvgElement) => {
  const Icon = (props: IconProps) => <HugeiconsIcon icon={iconSvg} {...props} />;
  return Icon;
};

export const Alert02Icon = createIcon(Alert02IconSvg);
export const ArrowDown01Icon = createIcon(ArrowDown01IconSvg);
export const ArrowLeft01Icon = createIcon(ArrowLeft01IconSvg);
export const ArrowLeft02Icon = AnimatedArrowLeft02Icon;
export const ArrowRight01Icon = createIcon(ArrowRight01IconSvg);
export const ArrowUp01Icon = createIcon(ArrowUp01IconSvg);
export const Calendar01Icon = createIcon(Calendar01IconSvg);
export const CallEnd01Icon = createIcon(CallEnd01IconSvg);
export const Cancel01Icon = AnimatedCancel01Icon;
export const CancelCircleIcon = createIcon(CancelCircleIconSvg);
export const CheckmarkCircle02Icon = createIcon(CheckmarkCircle02IconSvg);
export const CircleIcon = createIcon(CircleIconSvg);
export const Clock01Icon = AnimatedClock01Icon;
export const ColumnIcon = createIcon(LayoutTwoColumnIconSvg);
export const Copy01Icon = AnimatedCopy01Icon;
export const Crown01Icon = AnimatedCrown01Icon;
export const Download01Icon = AnimatedDownload01Icon;
export const Edit02Icon = AnimatedEdit02Icon;
export const FileTextIcon = createIcon(FileTextIconSvg);
export const GridIcon = createIcon(GridIconSvg);
export const HandIcon = createIcon(HandIconSvg);
export const Home01Icon = AnimatedHome01Icon;
export const Image01Icon = AnimatedImage01Icon;
export const InformationCircleIcon = AnimatedInformationCircleIcon;
export const LayoutGridIcon = createIcon(LayoutGridIconSvg);
export const LayoutTableIcon = createIcon(LayoutTableIconSvg);
export const Link01Icon = AnimatedLink01Icon;
export const Loading01Icon = createIcon(Loading01IconSvg);
export const Mail01Icon = AnimatedMail01Icon;
export const Maximize01Icon = AnimatedMaximize01Icon;
export const Message01Icon = AnimatedMessage01Icon;
export const Microphone01Icon = AnimatedMicrophone01Icon;
export const MicrophoneOff01Icon = createIcon(MicrophoneOff01IconSvg);
export const Moon02Icon = AnimatedMoon02Icon;
export const Monitor01Icon = createIcon(Monitor01IconSvg);
export const MonitorOffIcon = createIcon(MonitorOffIconSvg);
export const MoreHorizontalIcon = AnimatedMoreHorizontalIcon;
export const MoreVerticalIcon = AnimatedMoreVerticalIcon;
export const PauseIcon = AnimatedPauseIcon;
export const PictureInPictureIcon = createIcon(LayoutTableIconSvg);
export const Pin01Icon = AnimatedPin01Icon;
export const PlayIcon = AnimatedPlayIcon;
export const PlusSignIcon = AnimatedPlusSignIcon;
export const QrCode01Icon = AnimatedQrCode01Icon;
export const Radio01Icon = createIcon(Radio01IconSvg);
export const RefreshIcon = AnimatedRefreshIcon;
export const Search01Icon = AnimatedSearch01Icon;
export const SentIcon = AnimatedSentIcon;
export const Settings01Icon = AnimatedSettings01Icon;
export const Share01Icon = AnimatedShare01Icon;
export const Shield01Icon = AnimatedShield01Icon;
export const SignalFull02Icon = createIcon(SignalFull02IconSvg);
export const SmileIcon = AnimatedSmileIcon;
export const SparklesIcon = AnimatedSparklesIcon;
export const SquareIcon = createIcon(SquareIconSvg);
export const StarIcon = AnimatedStarIcon;
export const Sun02Icon = createIcon(Sun02IconSvg);
export const TextIcon = createIcon(TextIconSvg);
export const ThumbsUpIcon = AnimatedThumbsUpIcon;
export const Tick01Icon = createIcon(Tick01IconSvg);
export const TickDouble01Icon = createIcon(TickDouble01IconSvg);
export const Upload01Icon = AnimatedUpload01Icon;
export const UserAdd01Icon = AnimatedUserAdd01Icon;
export const UserGroupIcon = AnimatedUserGroupIcon;
export const UserRemove01Icon = AnimatedUserRemove01Icon;
export const Video01Icon = AnimatedVideo01Icon;
export const VideoOffIcon = createIcon(VideoOffIconSvg);
export const VolumeHighIcon = AnimatedVolumeHighIcon;
export const VolumeMute01Icon = AnimatedVolumeMute01Icon;
export const WifiOffIcon = createIcon(WifiOffIconSvg);
export const ZoomInIcon = AnimatedZoomInIcon;
export const ZoomOutIcon = AnimatedZoomOutIcon;

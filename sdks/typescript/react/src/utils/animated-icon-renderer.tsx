"use client";

import ArrowLeft02IconSvg from "@hugeicons/core-free-icons/ArrowLeft02Icon";
import Cancel01IconSvg from "@hugeicons/core-free-icons/Cancel01Icon";
import Clock01IconSvg from "@hugeicons/core-free-icons/Clock01Icon";
import Copy01IconSvg from "@hugeicons/core-free-icons/Copy01Icon";
import Crown01IconSvg from "@hugeicons/core-free-icons/CrownIcon";
import Download01IconSvg from "@hugeicons/core-free-icons/Download01Icon";
import Edit02IconSvg from "@hugeicons/core-free-icons/Edit02Icon";
import Home01IconSvg from "@hugeicons/core-free-icons/Home01Icon";
import Image01IconSvg from "@hugeicons/core-free-icons/Image01Icon";
import InformationCircleIconSvg from "@hugeicons/core-free-icons/InformationCircleIcon";
import Link01IconSvg from "@hugeicons/core-free-icons/Link01Icon";
import Mail01IconSvg from "@hugeicons/core-free-icons/Mail01Icon";
import MaximizeScreenIconSvg from "@hugeicons/core-free-icons/MaximizeScreenIcon";
import Message01IconSvg from "@hugeicons/core-free-icons/Message01Icon";
import Mic01IconSvg from "@hugeicons/core-free-icons/Mic01Icon";
import Moon02IconSvg from "@hugeicons/core-free-icons/Moon02Icon";
import MoreHorizontalIconSvg from "@hugeicons/core-free-icons/MoreHorizontalIcon";
import MoreVerticalIconSvg from "@hugeicons/core-free-icons/MoreVerticalIcon";
import PauseIconSvg from "@hugeicons/core-free-icons/PauseIcon";
import PinIconSvg from "@hugeicons/core-free-icons/PinIcon";
import PlayIconSvg from "@hugeicons/core-free-icons/PlayIcon";
import PlusSignIconSvg from "@hugeicons/core-free-icons/PlusSignIcon";
import QrCode01IconSvg from "@hugeicons/core-free-icons/QrCode01Icon";
import RefreshIconSvg from "@hugeicons/core-free-icons/RefreshIcon";
import Search01IconSvg from "@hugeicons/core-free-icons/Search01Icon";
import SentIconSvg from "@hugeicons/core-free-icons/SentIcon";
import Settings01IconSvg from "@hugeicons/core-free-icons/Settings01Icon";
import Share01IconSvg from "@hugeicons/core-free-icons/Share01Icon";
import Shield01IconSvg from "@hugeicons/core-free-icons/Shield01Icon";
import SmileIconSvg from "@hugeicons/core-free-icons/SmileIcon";
import SparklesIconSvg from "@hugeicons/core-free-icons/SparklesIcon";
import StarIconSvg from "@hugeicons/core-free-icons/StarIcon";
import ThumbsUpIconSvg from "@hugeicons/core-free-icons/ThumbsUpIcon";
import Upload01IconSvg from "@hugeicons/core-free-icons/Upload01Icon";
import UserAdd01IconSvg from "@hugeicons/core-free-icons/UserAdd01Icon";
import UserGroupIconSvg from "@hugeicons/core-free-icons/UserGroupIcon";
import UserRemove01IconSvg from "@hugeicons/core-free-icons/UserRemove01Icon";
import Video01IconSvg from "@hugeicons/core-free-icons/Video01Icon";
import VolumeHighIconSvg from "@hugeicons/core-free-icons/VolumeHighIcon";
import VolumeMute01IconSvg from "@hugeicons/core-free-icons/VolumeMute01Icon";
import ZoomInAreaIconSvg from "@hugeicons/core-free-icons/ZoomInAreaIcon";
import ZoomOutAreaIconSvg from "@hugeicons/core-free-icons/ZoomOutAreaIcon";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentPropsWithoutRef, ComponentType, SVGAttributes } from "react";
import {
  ArrowLeft02Icon,
  Cancel01Icon,
  Clock01Icon,
  Copy01Icon,
  CrownIcon as Crown01Icon,
  Download01Icon,
  Edit02Icon,
  Home01Icon,
  Image01Icon,
  InformationCircleIcon,
  Link01Icon,
  Mail01Icon,
  MaximizeScreenIcon as Maximize01Icon,
  Message01Icon,
  Mic01Icon as Microphone01Icon,
  Moon02Icon,
  MoreHorizontalIcon,
  MoreVerticalIcon,
  PauseIcon,
  PinIcon as Pin01Icon,
  PlayIcon,
  PlusSignIcon,
  QrCode01Icon,
  RefreshIcon,
  Search01Icon,
  SentIcon,
  Settings01Icon,
  Share08Icon as Share01Icon,
  Shield02Icon as Shield01Icon,
  SmileIcon,
  SparklesIcon,
  StarIcon,
  ThumbsUpIcon,
  Upload01Icon,
  UserAdd01Icon,
  UserGroupIcon,
  UserRemove01Icon,
  Video01Icon,
  VolumeHighIcon,
  VolumeMute01Icon,
  ZoomInAreaIcon as ZoomInIcon,
  ZoomOutAreaIcon as ZoomOutIcon,
} from "./animated-icons";

type AnimatedIconProps = SVGAttributes<SVGSVGElement> & {
  size?: number | string;
};
type AnimatedIconComponent = ComponentType<AnimatedIconProps>;

function getIconKey(icon: IconSvgElement) {
  return JSON.stringify(icon);
}

const animatedIcons = new Map<string, AnimatedIconComponent>([
  [getIconKey(ArrowLeft02IconSvg), ArrowLeft02Icon],
  [getIconKey(Cancel01IconSvg), Cancel01Icon],
  [getIconKey(Clock01IconSvg), Clock01Icon],
  [getIconKey(Copy01IconSvg), Copy01Icon],
  [getIconKey(Crown01IconSvg), Crown01Icon],
  [getIconKey(Download01IconSvg), Download01Icon],
  [getIconKey(Edit02IconSvg), Edit02Icon],
  [getIconKey(Home01IconSvg), Home01Icon],
  [getIconKey(Image01IconSvg), Image01Icon],
  [getIconKey(InformationCircleIconSvg), InformationCircleIcon],
  [getIconKey(Link01IconSvg), Link01Icon],
  [getIconKey(Mail01IconSvg), Mail01Icon],
  [getIconKey(MaximizeScreenIconSvg), Maximize01Icon],
  [getIconKey(Message01IconSvg), Message01Icon],
  [getIconKey(Mic01IconSvg), Microphone01Icon],
  [getIconKey(Moon02IconSvg), Moon02Icon],
  [getIconKey(MoreHorizontalIconSvg), MoreHorizontalIcon],
  [getIconKey(MoreVerticalIconSvg), MoreVerticalIcon],
  [getIconKey(PauseIconSvg), PauseIcon],
  [getIconKey(PinIconSvg), Pin01Icon],
  [getIconKey(PlayIconSvg), PlayIcon],
  [getIconKey(PlusSignIconSvg), PlusSignIcon],
  [getIconKey(QrCode01IconSvg), QrCode01Icon],
  [getIconKey(RefreshIconSvg), RefreshIcon],
  [getIconKey(Search01IconSvg), Search01Icon],
  [getIconKey(SentIconSvg), SentIcon],
  [getIconKey(Settings01IconSvg), Settings01Icon],
  [getIconKey(Share01IconSvg), Share01Icon],
  [getIconKey(Shield01IconSvg), Shield01Icon],
  [getIconKey(SmileIconSvg), SmileIcon],
  [getIconKey(SparklesIconSvg), SparklesIcon],
  [getIconKey(StarIconSvg), StarIcon],
  [getIconKey(ThumbsUpIconSvg), ThumbsUpIcon],
  [getIconKey(Upload01IconSvg), Upload01Icon],
  [getIconKey(UserAdd01IconSvg), UserAdd01Icon],
  [getIconKey(UserGroupIconSvg), UserGroupIcon],
  [getIconKey(UserRemove01IconSvg), UserRemove01Icon],
  [getIconKey(Video01IconSvg), Video01Icon],
  [getIconKey(VolumeHighIconSvg), VolumeHighIcon],
  [getIconKey(VolumeMute01IconSvg), VolumeMute01Icon],
  [getIconKey(ZoomInAreaIconSvg), ZoomInIcon],
  [getIconKey(ZoomOutAreaIconSvg), ZoomOutIcon],
]);

export function AnimatedHugeiconsIcon({ icon, size = 24, strokeWidth, absoluteStrokeWidth = false, color = "currentColor", primaryColor, secondaryColor, disableSecondaryOpacity = false, altIcon, showAlt = false, ...props }: ComponentPropsWithoutRef<typeof HugeiconsIcon> & { icon: IconSvgElement }) {
  const supportsAnimatedRendering = !(showAlt && altIcon) && secondaryColor === undefined && !disableSecondaryOpacity;
  const AnimatedIcon = supportsAnimatedRendering ? animatedIcons.get(getIconKey(icon)) : undefined;

  if (!AnimatedIcon) {
    return <HugeiconsIcon icon={icon} size={size} strokeWidth={strokeWidth} absoluteStrokeWidth={absoluteStrokeWidth} color={color} primaryColor={primaryColor} secondaryColor={secondaryColor} disableSecondaryOpacity={disableSecondaryOpacity} altIcon={altIcon} showAlt={showAlt} {...props} />;
  }

  const calculatedStrokeWidth = strokeWidth === undefined ? undefined : absoluteStrokeWidth ? (strokeWidth * 24) / Number(size) : strokeWidth;

  return <AnimatedIcon {...props} size={size} color={primaryColor ?? color} strokeWidth={calculatedStrokeWidth} />;
}

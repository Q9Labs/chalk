import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import DashboardSquare01Icon from "@hugeicons/core-free-icons/DashboardSquare01Icon";
import Home01Icon from "@hugeicons/core-free-icons/Home01Icon";
import Logout03Icon from "@hugeicons/core-free-icons/Logout03Icon";
import MoreHorizontalIcon from "@hugeicons/core-free-icons/MoreHorizontalIcon";
import PlayCircleIcon from "@hugeicons/core-free-icons/PlayCircleIcon";
import PlusSignIcon from "@hugeicons/core-free-icons/PlusSignIcon";
import Settings02Icon from "@hugeicons/core-free-icons/Settings02Icon";
import SourceCodeIcon from "@hugeicons/core-free-icons/SourceCodeIcon";
import UnfoldMoreIcon from "@hugeicons/core-free-icons/UnfoldMoreIcon";
import UserCircleIcon from "@hugeicons/core-free-icons/UserCircleIcon";
import type { IconSvgElement } from "@hugeicons/react";
import {
  Menu,
  MenuContent,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  cn,
  useSidebar,
} from "@q9labsai/chalk-ui";
import { useDashboardAccount } from "./DashboardAccount";

const primaryNavigation = [
  { to: "/home", label: "Overview", icon: Home01Icon },
  { to: "/spaces", label: "Spaces", icon: DashboardSquare01Icon },
  { to: "/episodes", label: "Episodes", icon: PlayCircleIcon },
] as const;

const utilityNavigation = [{ to: "/developer", label: "Developer", icon: SourceCodeIcon }] as const;

/** Text that folds away when the sidebar collapses to its icon rail. */
const collapsedHidden = "group-data-[collapsible=icon]:hidden";

export function DashboardSidebar({ pathname, onCreateSpace }: { pathname: string; onCreateSpace: () => void }) {
  const { account, current, tenants, selectTenant, signOut } = useDashboardAccount();
  const initials = account.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <Sidebar title="Dashboard navigation">
      <SidebarHeader className="gap-3">
        <div className="flex h-9 items-center gap-2 px-1 group-data-[collapsible=icon]:px-0">
          <Link to="/home" aria-label="Chalk home" className="flex min-w-0 flex-1 items-center gap-2.5 group-data-[collapsible=icon]:justify-center">
            <img src="/brand/chalk/chalk-icon.svg" alt="" className="size-6 shrink-0" />
            <span className={cn("text-sidebar-primary text-base font-semibold tracking-tight", collapsedHidden)}>Chalk</span>
          </Link>
          <SidebarTrigger className={cn("text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring/60", collapsedHidden)} />
        </div>

        <TenantSwitcher currentTenantID={current.tenant.id} tenantName={current.tenant.name} role={current.access.role} tenants={tenants} onSelect={selectTenant} />

        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton variant="primary" tooltip="New Space" onClick={onCreateSpace}>
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={1.8} />
              <span className={collapsedHidden}>New Space</span>
              <kbd className={cn("bg-sidebar-primary-foreground/10 ml-auto rounded px-1.5 py-0.5 font-mono text-[10px]", collapsedHidden)}>N</kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <NavigationGroup label="Workspace" items={primaryNavigation} pathname={pathname} />
        <NavigationGroup label="Tools" items={utilityNavigation} pathname={pathname} />
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Tenant settings" isActive={pathname === "/tenant"} render={<Link to="/tenant" />}>
              <HugeiconsIcon icon={Settings02Icon} strokeWidth={1.6} />
              <span className={collapsedHidden}>Tenant settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <Menu>
              <SidebarMenuButton size="lg" tooltip={account.name} aria-label="Account menu" render={<MenuTrigger />}>
                <span className="bg-sidebar-accent text-sidebar-accent-foreground flex size-7 shrink-0 items-center justify-center rounded-full font-mono text-[11px]">{initials}</span>
                <span className={cn("flex min-w-0 flex-1 flex-col text-left", collapsedHidden)}>
                  <span className="text-sidebar-primary truncate text-sm">{account.name}</span>
                  <span className="truncate text-xs opacity-60">{account.email}</span>
                </span>
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={1.6} className={collapsedHidden} />
              </SidebarMenuButton>
              <MenuContent tone="sidebar" side="top" align="start" className="min-w-56">
                <MenuItem render={<Link to="/account" />}>
                  <HugeiconsIcon icon={UserCircleIcon} strokeWidth={1.6} />
                  Account settings
                </MenuItem>
                <MenuSeparator />
                <MenuItem onClick={() => void signOut()}>
                  <HugeiconsIcon icon={Logout03Icon} strokeWidth={1.6} />
                  Sign out
                </MenuItem>
              </MenuContent>
            </Menu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

function NavigationGroup({ label, items, pathname }: { label: string; items: readonly { to: string; label: string; icon: IconSvgElement }[]; pathname: string }) {
  const { setOpenMobile, isMobile } = useSidebar();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const active = pathname === item.to || pathname.startsWith(`${item.to}/`);
          return (
            <SidebarMenuItem key={item.to}>
              <SidebarMenuButton
                isActive={active}
                tooltip={item.label}
                onClick={() => {
                  if (isMobile) setOpenMobile(false);
                }}
                render={<Link to={item.to} aria-current={active ? "page" : undefined} />}
              >
                <HugeiconsIcon icon={item.icon} strokeWidth={1.6} />
                <span className={collapsedHidden}>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function TenantSwitcher({ currentTenantID, tenantName, role, tenants, onSelect }: { currentTenantID: string; tenantName: string; role: string; tenants: readonly { tenant: { id: string; name: string }; access: { role: string } }[]; onSelect: (tenantID: string) => void }) {
  return (
    <Menu>
      <SidebarMenuButton size="lg" variant="outline" aria-label="Switch Tenant" tooltip={tenantName} render={<MenuTrigger />}>
        <span className="bg-sidebar-primary text-sidebar-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-md font-mono text-xs">{tenantName.slice(0, 1).toUpperCase()}</span>
        <span className={cn("flex min-w-0 flex-1 flex-col text-left", collapsedHidden)}>
          <span className="text-sidebar-primary truncate text-sm">{tenantName}</span>
          <span className="truncate text-xs opacity-60">{role}</span>
        </span>
        <HugeiconsIcon icon={UnfoldMoreIcon} strokeWidth={1.6} className={collapsedHidden} />
      </SidebarMenuButton>
      <MenuContent tone="sidebar" align="start" className="min-w-(--anchor-width)">
        <MenuGroupLabel>Your Tenants</MenuGroupLabel>
        <MenuRadioGroup
          value={currentTenantID}
          onValueChange={(value: unknown) => {
            if (typeof value === "string") onSelect(value);
          }}
        >
          {tenants.map((item) => (
            <MenuRadioItem key={item.tenant.id} value={item.tenant.id} closeOnClick>
              <span className="bg-sidebar-accent text-sidebar-accent-foreground flex size-6 shrink-0 items-center justify-center rounded font-mono text-[11px]">{item.tenant.name.slice(0, 1).toUpperCase()}</span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{item.tenant.name}</span>
                <span className="truncate text-xs opacity-60">{item.access.role}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem render={<Link to="/tenant" />}>Manage current Tenant</MenuItem>
      </MenuContent>
    </Menu>
  );
}

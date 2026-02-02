import { Link, useRouterState } from "@tanstack/react-router"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { EnvSwitcher } from "./env-switcher"

const navItems = [
  { label: "Overview", to: "/" },
  { label: "Tenants", to: "/tenants" },
  { label: "Rooms", to: "/rooms" },
  { label: "Recordings", to: "/recordings" },
  { label: "Transcripts", to: "/transcripts" },
  { label: "Webhooks", to: "/webhooks" },
  { label: "Audit Logs", to: "/audit-logs" },
  { label: "Usage", to: "/usage" },
] as const

export function AppSidebar() {
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname

  return (
    <Sidebar>
      <SidebarHeader className="border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-600 text-white font-bold text-sm">
            C
          </div>
          <div>
            <div className="font-semibold text-sm">Chalk Admin</div>
            <div className="text-xs text-muted-foreground">Dashboard</div>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    render={<Link to={item.to} />}
                    isActive={
                      item.to === "/"
                        ? currentPath === "/"
                        : currentPath.startsWith(item.to)
                    }
                  >
                    {item.label}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t">
        <EnvSwitcher />
      </SidebarFooter>
    </Sidebar>
  )
}

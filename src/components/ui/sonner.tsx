import { Toaster as Sonner, type ToasterProps } from "sonner"
import { Icon } from "@/components/ui/icon"

// Follows the OS appearance; the app has no in-app theme switch.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="system"
      className="toaster group"
      icons={{
        success: <Icon name="check_circle" size={16} />,
        info: <Icon name="info" size={16} />,
        warning: <Icon name="warning" size={16} />,
        error: <Icon name="error" size={16} />,
        loading: <Icon name="progress_activity" size={16} className="animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }

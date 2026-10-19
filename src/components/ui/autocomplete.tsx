"use client"

import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete"
import { cn } from "@/lib/utils"

/** A text field that suggests values as you type, keeping whatever is typed (shadcn style, on Base UI). */
const Autocomplete = AutocompletePrimitive.Root

function AutocompleteInput({ className, ...props }: AutocompletePrimitive.Input.Props) {
  return (
    <AutocompletePrimitive.Input
      data-slot="autocomplete-input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 dark:bg-input/30",
        className
      )}
      {...props}
    />
  )
}

function AutocompleteContent({
  className,
  children,
  side = "top",
  sideOffset = 4,
  align = "start",
  ...props
}: AutocompletePrimitive.Popup.Props & Pick<AutocompletePrimitive.Positioner.Props, "side" | "sideOffset" | "align">) {
  return (
    <AutocompletePrimitive.Portal>
      <AutocompletePrimitive.Positioner side={side} sideOffset={sideOffset} align={align} className="isolate z-50 outline-hidden">
        <AutocompletePrimitive.Popup
          data-slot="autocomplete-content"
          className={cn(
            "max-h-[min(var(--available-height),20rem)] w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) overflow-y-auto overscroll-contain rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[empty]:hidden data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
            className
          )}
          {...props}
        >
          {children}
        </AutocompletePrimitive.Popup>
      </AutocompletePrimitive.Positioner>
    </AutocompletePrimitive.Portal>
  )
}

const AutocompleteList = AutocompletePrimitive.List

function AutocompleteItem({ className, ...props }: AutocompletePrimitive.Item.Props) {
  return (
    <AutocompletePrimitive.Item
      data-slot="autocomplete-item"
      className={cn(
        "flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Autocomplete, AutocompleteContent, AutocompleteInput, AutocompleteItem, AutocompleteList }

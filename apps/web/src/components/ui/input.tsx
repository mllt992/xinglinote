import * as React from "react";
import { cn } from "../../lib/utils";
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, type, ...props }, ref) => <input type={type} ref={ref} className={cn("flex h-9 w-full rounded-lg border border-input bg-background px-3 py-1 text-sm shadow-sm outline-none transition placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-50", className)} {...props} />);
Input.displayName = "Input";

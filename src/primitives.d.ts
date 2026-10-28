/**
 * Ambient types for @deepseek-ai/dsh-client-ui-primitives —— 运行期由宿主的冻结模块表提供，
 * 编译期没有公开类型，所以只声明本插件用到的三个组件。
 */
declare module "@deepseek-ai/dsh-client-ui-primitives" {
  import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode } from "react";

  export type ButtonVariant = "primary" | "ghost" | "outline" | "toolbar";

  export function Button(props: {
    variant?: ButtonVariant;
    size?: "md" | "sm";
    icon?: ReactNode;
    className?: string | undefined;
    children?: ReactNode;
    disabled?: boolean;
    title?: string;
    onClick?: (event: unknown) => void;
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactElement;

  export function Input(props: {
    icon?: ReactNode;
    className?: string;
    allowClear?: boolean;
    onPressEnter?: (event: unknown) => void;
  } & InputHTMLAttributes<HTMLInputElement>): ReactElement;

  export function Modal(props: {
    open?: boolean;
    onClose?: () => void;
    title?: ReactNode;
    closeLabel?: string;
    description?: string;
    children?: ReactNode;
    footer?: ReactNode;
    className?: string;
    contentClassName?: string;
    headless?: boolean;
    backdropBlur?: boolean;
  }): ReactElement | null;
}

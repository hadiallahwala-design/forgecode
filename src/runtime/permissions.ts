export interface PermissionHandler {
  confirm(message: string): Promise<boolean>;
}

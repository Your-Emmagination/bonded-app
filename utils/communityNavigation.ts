let shouldReopenServerDrawer = false;

export function requestServerDrawerReopen() {
  shouldReopenServerDrawer = true;
}

export function consumeServerDrawerReopenRequest() {
  const nextValue = shouldReopenServerDrawer;
  shouldReopenServerDrawer = false;
  return nextValue;
}

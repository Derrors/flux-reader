import App from '../App';
import { WINDOWS_APP_PROFILE } from '../platform/profiles';

export default function WindowsApp() {
  return <App profile={WINDOWS_APP_PROFILE} />;
}

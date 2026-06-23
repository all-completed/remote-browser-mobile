import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.allcompleted.rbkeeper',
  appName: 'Remote Browser Keeper',
  webDir: 'www',
  server: {
    androidScheme: 'https',
  },
};

export default config;

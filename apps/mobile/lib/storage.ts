/**
 * AsyncStorage-based token persistence
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const TOKEN_KEY = '@chalk/token';
const REFRESH_TOKEN_KEY = '@chalk/refresh_token';

export const storage = {
  async getToken() {
    return AsyncStorage.getItem(TOKEN_KEY);
  },

  async setToken(token: string) {
    return AsyncStorage.setItem(TOKEN_KEY, token);
  },

  async getRefreshToken() {
    return AsyncStorage.getItem(REFRESH_TOKEN_KEY);
  },

  async setRefreshToken(token: string) {
    return AsyncStorage.setItem(REFRESH_TOKEN_KEY, token);
  },

  async clearTokens() {
    await AsyncStorage.multiRemove([TOKEN_KEY, REFRESH_TOKEN_KEY]);
  },
};

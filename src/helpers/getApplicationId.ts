import type { ExtensionConfiguration } from "../config";
import { CONFIG_KEYS } from "../constants";

export const getApplicationId = (config: ExtensionConfiguration) => {
    return { clientId: config.get(CONFIG_KEYS.App.Id)! };
};

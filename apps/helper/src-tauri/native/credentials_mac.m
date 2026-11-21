#import <Foundation/Foundation.h>
#import <Security/Security.h>

bool chalk_store_credential(const char *serviceName, const uint8_t *data, size_t length) {
    @autoreleasepool {
        NSString *service = [NSString stringWithUTF8String:serviceName];
        if (service == nil) return false;
        // A nil path refers to this executable. Other apps are not on the
        // login Keychain item's trusted application list.
        SecTrustedApplicationRef trusted = NULL;
        if (SecTrustedApplicationCreateFromPath(NULL, &trusted) != errSecSuccess) return false;
        SecAccessRef access = NULL;
        NSArray *applications = @[CFBridgingRelease(trusted)];
        if (SecAccessCreate(CFSTR("Chalk Helper device credential"), (__bridge CFArrayRef)applications, &access) != errSecSuccess) return false;
        NSDictionary *key = @{
            (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: service,
            (__bridge id)kSecAttrAccount: @"Chalk Helper",
        };
        NSDictionary *attributes = @{
            (__bridge id)kSecAttrAccess: CFBridgingRelease(access),
            (__bridge id)kSecValueData: [NSData dataWithBytes:data length:length],
        };
        NSMutableDictionary *item = [key mutableCopy];
        [item addEntriesFromDictionary:attributes];
        OSStatus status = SecItemAdd((__bridge CFDictionaryRef)item, NULL);
        if (status == errSecDuplicateItem) {
            status = SecItemUpdate((__bridge CFDictionaryRef)key, (__bridge CFDictionaryRef)attributes);
        }
        return status == errSecSuccess;
    }
}

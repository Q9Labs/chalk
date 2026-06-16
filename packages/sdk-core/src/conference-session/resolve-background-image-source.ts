const isDirectImageSource = (imageUrl: string) => imageUrl.startsWith("blob:") || imageUrl.startsWith("data:");

export const resolveBackgroundImageSource = async (imageUrl: string) => {
  if (typeof window === "undefined" || isDirectImageSource(imageUrl)) {
    return { imageUrl };
  }

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch background image: ${imageUrl} (${response.status})`);
  }

  const imageBlob = await response.blob();
  const objectUrl = URL.createObjectURL(imageBlob);

  return {
    imageUrl: objectUrl,
    revoke: () => URL.revokeObjectURL(objectUrl),
  };
};

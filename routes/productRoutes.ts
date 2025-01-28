import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';
import { v4 as uuidv4 } from 'uuid';
import { PrismaClient } from '@prisma/client/edge';
import { withAccelerate } from '@prisma/extension-accelerate';
import JSZip from 'jszip';
import QRCode from 'qrcode-generator';

// Singleton PrismaClient
let prismaClient: PrismaClient | null = null;

const getPrismaClient = (databaseUrl: string) => {
    if (!prismaClient) {
        prismaClient = new PrismaClient({
            datasourceUrl: databaseUrl,
        }).$extends(withAccelerate());
    }
    return prismaClient;
};

// Cache for location names
const locationCache = new Map<string, string>();
const CACHE_DURATION = 3600000; // 1 hour in milliseconds

export const qrCodeRouter = new Hono<{
    Bindings: {
        DATABASE_URL: string;
        AES_SECRET_KEY: string;
    }
}>();

const generateQRCode = async (data: string): Promise<string> => {
    const qr = QRCode(0, 'L');
    qr.addData(data);
    qr.make();
    return qr.createDataURL(10);
};

const fetchLocationName = async (latitude: number, longitude: number): Promise<string> => {
    const cacheKey = `${latitude},${longitude}`;
    const cachedLocation = locationCache.get(cacheKey);
    
    if (cachedLocation) {
        return cachedLocation;
    }

    try {
        const response = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`,
            {
                headers: {
                    'User-Agent': 'QRCodeApp/1.0'
                }
            }
        );
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        const locationName = data.display_name || 'Location Name Not Found';
        
        // Cache the result
        locationCache.set(cacheKey, locationName);
        setTimeout(() => locationCache.delete(cacheKey), CACHE_DURATION);
        
        return locationName;
    } catch (error) {
        console.error('Error fetching location name:', error);
        return 'Error Fetching Location';
    }
};

qrCodeRouter.post('/sign', async (c) => {
    try {
        const { name, stationId, numberOfCodes } = await c.req.json();
        
        if (!name || !stationId || !numberOfCodes || numberOfCodes <= 0 || numberOfCodes > 1000) {
            return c.json({ error: 'Invalid input parameters' }, 400);
        }

        const batchId = uuidv4();
        const signedQRCodes: string[] = [];
        const prisma = getPrismaClient(c.env.DATABASE_URL);

        for (let i = 0; i < numberOfCodes; i++) {
            const uuid = uuidv4();
            const qrData = { name, stationId, uuid };
            const signedQRCode = await sign(qrData, c.env.AES_SECRET_KEY);

            await prisma.product.create({
                data: {
                    name,
                    stationId,
                    uuid,
                    signedQRCode,
                    batchId,
                    createdAt: new Date(),
                }
            });
            signedQRCodes.push(signedQRCode);
        }

        const masterQRData = { batchId };
        const masterQRCode = await sign(masterQRData, c.env.AES_SECRET_KEY);

        await prisma.masterQRCode.create({
            data: {
                batchId,
                masterQRCode,
                createdAt: new Date(),
            },
        });

        return c.json({
            message: `${numberOfCodes} QR codes signed and stored successfully`,
            signedQRCodes,
            masterQRCode,
            batchId
        });
    } catch (error) {
        console.error('Error saving QR codes:', error);
        return c.json({ error: 'Error signing QR codes' }, 500);
    }
});

qrCodeRouter.get('/batch/:batchId/download', async (c) => {
    const batchId = c.req.param('batchId');
    
    try {
        const prisma = getPrismaClient(c.env.DATABASE_URL);
        const products = await prisma.product.findMany({
            where: { batchId }
        });

        if (products.length === 0) {
            return c.json({ error: 'No products found for this batch' }, 404);
        }

        const masterQRCode = await prisma.masterQRCode.findUnique({
            where: { batchId }
        });

        const zip = new JSZip();
        
        // Generate QR codes in parallel
        await Promise.all([
            ...products.map(async (product) => {
                const qrCode = await generateQRCode(product.signedQRCode);
                const base64Data = qrCode.split(',')[1];
                zip.file(`${product.uuid}.png`, base64Data, {base64: true});
            }),
            masterQRCode ? (async () => {
                const masterQrCode = await generateQRCode(masterQRCode.masterQRCode);
                const base64Data = masterQrCode.split(',')[1];
                zip.file(`master-${batchId}.png`, base64Data, {base64: true});
            })() : Promise.resolve()
        ]);

        const zipContent = await zip.generateAsync({ type: 'uint8array' });

        const headers = new Headers({
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename=batch-${batchId}.zip`,
        });

        return new Response(zipContent, { headers });
    } catch (error) {
        console.error('Error generating batch ZIP:', error);
        return c.json({ error: 'Error generating batch ZIP file' }, 500);
    }
});

qrCodeRouter.post('/scan', async (c) => {
    try {
        const { signedQRCode, location } = await c.req.json();
        if (!signedQRCode || !location?.latitude || !location?.longitude) {
            return c.json({ error: 'Invalid input parameters' }, 400);
        }

        const decodedData = await verify(signedQRCode, c.env.AES_SECRET_KEY);
        const prisma = getPrismaClient(c.env.DATABASE_URL);

        const { latitude, longitude } = location;
        const locationName = await fetchLocationName(latitude, longitude);

        if (decodedData.batchId && !decodedData.uuid) {
            const products = await prisma.product.findMany({
                where: { batchId: decodedData.batchId }
            });

            if (products.length === 0) {
                return c.json({ error: 'No products found for this batch' }, 404);
            }

            await Promise.all(products.map(product =>
                prisma.scan.create({
                    data: {
                        productId: product.id,
                        locationLatitude: latitude,
                        locationLongitude: longitude,
                        locationName,
                        scannedAt: new Date(),
                    }
                })
            ));

            return c.json({
                batch: {
                    batchId: decodedData.batchId,
                    products: products.map(product => ({
                        name: product.name,
                        stationId: product.stationId,
                        uuid: product.uuid
                    }))
                }
            });
        }

        if (decodedData.uuid) {
            const product = await prisma.product.findUnique({
                where: { uuid: decodedData.uuid }
            });

            if (!product) {
                return c.json({ error: 'Product not found' }, 404);
            }

            await prisma.scan.create({
                data: {
                    productId: product.id,
                    locationLatitude: latitude,
                    locationLongitude: longitude,
                    locationName,
                    scannedAt: new Date(),
                }
            });

            return c.json({ product });
        }

        return c.json({ error: 'Unrecognized QR code type' }, 400);
    } catch (error) {
        console.error('Error verifying QR code:', error);
        return c.json({ error: 'Invalid or expired QR code' }, 400);
    }
});

qrCodeRouter.get('/scan-history', async (c) => {
    const signedQRCode = c.req.query('signedQRCode');
    if (!signedQRCode) {
        return c.json({ error: 'QR code is required' }, 400);
    }

    try {
        const prisma = getPrismaClient(c.env.DATABASE_URL);
        const masterQR = await prisma.masterQRCode.findUnique({
            where: { masterQRCode: signedQRCode }
        });

        if (masterQR) {
            const products = await prisma.product.findMany({
                where: { batchId: masterQR.batchId },
                include: {
                    scans: {
                        orderBy: { scannedAt: 'desc' }
                    }
                }
            });

            return c.json({
                type: 'batch',
                data: {
                    batchId: masterQR.batchId,
                    createdAt: masterQR.createdAt,
                    products: products.map(product => ({
                        ...product,
                        scans: product.scans.map(scan => ({
                            location: {
                                latitude: Number(scan.locationLatitude),
                                longitude: Number(scan.locationLongitude)
                            },
                            scannedAt: scan.scannedAt,
                            locationName: scan.locationName
                        }))
                    }))
                }
            });
        }

        const product = await prisma.product.findUnique({
            where: { signedQRCode },
            include: {
                scans: {
                    orderBy: { scannedAt: 'desc' }
                }
            }
        });

        if (product) {
            return c.json({
                type: 'product',
                data: {
                    ...product,
                    scans: product.scans.map(scan => ({
                        location: {
                            latitude: Number(scan.locationLatitude),
                            longitude: Number(scan.locationLongitude)
                        },
                        scannedAt: scan.scannedAt,
                        locationName: scan.locationName
                    }))
                }
            });
        }

        return c.json({ error: 'No scan history found for this QR code' }, 404);
    } catch (error) {
        console.error('Error fetching scan history:', error);
        return c.json({ error: 'Failed to fetch scan history' }, 500);
    }
});

qrCodeRouter.post('/seller-scan', async (c) => {
    try {
        const { signedQRCode, location } = await c.req.json();
        if (!signedQRCode || !location?.latitude || !location?.longitude) {
            return c.json({ error: 'Invalid input parameters' }, 400);
        }

        const decodedData = await verify(signedQRCode, c.env.AES_SECRET_KEY);
        const prisma = getPrismaClient(c.env.DATABASE_URL);
        const { latitude, longitude } = location;
        const locationName = await fetchLocationName(latitude, longitude);

        if (decodedData.batchId && !decodedData.uuid) {
            const products = await prisma.product.findMany({
                where: { batchId: decodedData.batchId }
            });

            if (products.length === 0) {
                return c.json({ error: 'No products found for this batch' }, 404);
            }

            await Promise.all(products.map(product =>
                prisma.sellerScan.create({
                    data: {
                        productId: product.id,
                        locationLatitude: latitude,
                        locationLongitude: longitude,
                        locationName,
                        scannedAt: new Date(),
                    }
                })
            ));

            return c.json({
                batch: {
                    batchId: decodedData.batchId,
                    products: products.map(product => ({
                        name: product.name,
                        stationId: product.stationId,
                        uuid: product.uuid
                    }))
                }
            });
        }

        if (decodedData.uuid) {
            const product = await prisma.product.findUnique({
                where: { uuid: decodedData.uuid }
            });

            if (!product) {
                return c.json({ error: 'Product not found' }, 404);
            }

            await prisma.sellerScan.create({
                data: {
                    productId: product.id,
                    locationLatitude: latitude,
                    locationLongitude: longitude,
                    locationName,
                    scannedAt: new Date(),
                }
            });

            return c.json({ product });
        }

        return c.json({ error: 'Unrecognized QR code type' }, 400);
    } catch (error) {
        console.error('Error verifying QR code:', error);
        return c.json({ error: 'Invalid or expired QR code' }, 400);
    }
});